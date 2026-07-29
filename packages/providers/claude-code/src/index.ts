/**
 * @nexuscode/provider-claude-code — Claude Code driven headlessly as a
 * subprocess and normalized into the canonical {@link StreamChunk} union.
 *
 * This is NexusCode's differentiator: a coding CLI that edits files, runs
 * shells, and gates approvals becomes a first-class {@link ProviderAdapter},
 * interchangeable with chat providers behind the same streaming loop. All the
 * subprocess machinery (spawn, line-streaming, SIGINT→SIGTERM cancellation,
 * child reaping, completion/error rules) lives in
 * `@nexuscode/provider-subprocess`; this module only supplies:
 *   (a) the argv for `claude -p … --output-format stream-json --verbose`,
 *   (b) the Claude Code NDJSON → StreamChunk mapping, and
 *   (c) the declared capabilities.
 *
 * Drive contract (master-plan §4.8):
 *   claude -p "<prompt>" --output-format stream-json --verbose \
 *     --include-partial-messages --model <id> --permission-mode <mode> \
 *     [--allowedTools …] [--disallowedTools …] [--max-turns n] \
 *     [--append-system-prompt …] [--add-dir …] [--mcp-config file] \
 *     [--session-id <uuid> | --resume <uuid> | --continue]
 *
 * NDJSON schema (one object per line):
 *   {type:"system",subtype:"init",session_id,model,tools,mcp_servers}   → session-init
 *   {type:"stream_event",event:{content_block_delta,…}}                 → text/reasoning-delta
 *   {type:"assistant",message:{content:[{type:"tool_use",…}]}}          → tool-call + file-edit
 *   {type:"user",message:{content:[{type:"tool_result",…}]}}            → tool-result
 *   {type:"result",subtype,is_error,usage,total_cost_usd,result}        → terminal
 * The human TUI is never parsed — always `stream-json`.
 */

import type { CallContext, ChatResult, HealthStatus, ProviderAdapter } from "@nexuscode/core";
import type {
  Capabilities,
  ChatRequest,
  ContentBlock,
  EffortListResult,
  ModelInfo,
  ModelListResult,
  StreamChunk,
  Usage,
} from "@nexuscode/shared";
import { textOf } from "@nexuscode/shared";
import { createEffortListCache, createModelListCache, type EffortListCache, type ModelListCache } from "@nexuscode/shared";
import {
  createSubprocessAdapter,
  replaceDiff,
  writeDiff,
  runBoundedCapture,
  DEFAULT_PROBE_TIMEOUT_MS,
  type CliSpec,
  type StreamState,
  type SubprocessConfig,
} from "@nexuscode/provider-subprocess";

export const PROVIDER_ID = "claude-code";

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

/** Static configuration for {@link createClaudeCodeAdapter}. */
export interface ClaudeCodeConfig extends SubprocessConfig {
  /** Permission mode passed as `--permission-mode`. Default `"default"`. */
  permissionMode?: ClaudePermissionMode;
  /** `--allowedTools` list (e.g. `["Edit","Bash","Read"]`). */
  allowedTools?: string[];
  /** `--disallowedTools` list. */
  disallowedTools?: string[];
  /** `--max-turns` cap. */
  maxTurns?: number;
  /** Extra `--add-dir` roots the agent may read/write. */
  addDirs?: string[];
  /** Path to an `--mcp-config` JSON file. */
  mcpConfig?: string;
  /** Resume a prior session: `--resume <uuid>`. */
  resume?: string;
  /** Start with a fixed id: `--session-id <uuid>` (mutually exclusive w/ resume). */
  sessionId?: string;
  /** Continue the most recent session: `--continue`. */
  continue?: boolean;
}

// ── Argv ────────────────────────────────────────────────────────────────────────

/** The prompt is the latest user turn; falls back to all text joined. */
function promptOf(req: ChatRequest): string {
  const users = req.messages.filter((m) => m.role === "user");
  const last = users[users.length - 1];
  if (last) return textOf(last);
  return req.messages.map(textOf).join("\n\n");
}

function resolveModel(cfg: ClaudeCodeConfig, req: ChatRequest): string {
  return cfg.modelMap?.[req.model] ?? req.model;
}

function buildArgs(cfg: ClaudeCodeConfig, req: ChatRequest, ctx?: CallContext): string[] {
  const args: string[] = [
    "-p",
    promptOf(req),
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
  ];

  const model = resolveModel(cfg, req);
  if (model) args.push("--model", model);
  args.push("--permission-mode", cfg.permissionMode ?? "default");

  if (cfg.allowedTools?.length) args.push("--allowedTools", cfg.allowedTools.join(","));
  if (cfg.disallowedTools?.length) args.push("--disallowedTools", cfg.disallowedTools.join(","));
  if (cfg.maxTurns != null) args.push("--max-turns", String(cfg.maxTurns));
  // Real wire path for reasoning effort: `claude --help` documents a genuine
  // `--effort <level>` flag ("Effort level for the current session"),
  // verified live against claude-cli 2.1.220. `req.reasoning.effort` carries
  // whatever provider-native level name `--effort`/`applyEffort`
  // (`packages/cli/src/commands.ts`) resolved via THIS adapter's own
  // `listReasoningLevels` (see `probeClaudeCodeEffort` below) — sent
  // verbatim, never translated. `enabled: false` (the CLI's explicit "off")
  // omits the flag entirely so the session falls back to whatever effort the
  // user already has configured in `claude` itself, exactly like omitting
  // `--model` falls back to the CLI's own default.
  if (req.reasoning?.enabled && req.reasoning.effort) {
    args.push("--effort", req.reasoning.effort);
  }
  if (req.system) args.push("--append-system-prompt", req.system);
  for (const d of cfg.addDirs ?? []) args.push("--add-dir", d);
  if (cfg.mcpConfig) args.push("--mcp-config", cfg.mcpConfig);

  if (cfg.resume ?? ctx?.providerSessionId) args.push("--resume", cfg.resume ?? ctx?.providerSessionId ?? "");
  else if (cfg.sessionId) args.push("--session-id", cfg.sessionId);
  else if (cfg.continue) args.push("--continue");

  for (const extra of cfg.extraArgs ?? []) args.push(extra);
  return args;
}

// ── NDJSON → StreamChunk ──────────────────────────────────────────────────────

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
}

/** Edit/Write/MultiEdit tool_use → a normalized `file-edit` chunk. */
function toFileEdit(
  runId: string,
  block: ToolUseBlock,
  mode: ClaudePermissionMode,
  raw: unknown,
): Extract<StreamChunk, { type: "file-edit" }> | undefined {
  const input = block.input ?? {};
  const path = (input.file_path ?? input.path) as string | undefined;
  if (!path) return undefined;

  const applied = mode === "acceptEdits" || mode === "bypassPermissions";
  const status: "proposed" | "applied" = applied ? "applied" : "proposed";

  let diff: string | undefined;
  if (block.name === "Write") {
    diff = writeDiff(path, String(input.content ?? ""));
  } else if (block.name === "Edit") {
    diff = replaceDiff(path, String(input.old_string ?? ""), String(input.new_string ?? ""));
  } else if (block.name === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
    diff = edits
      .map((e) => replaceDiff(path, String(e.old_string ?? ""), String(e.new_string ?? "")))
      .join("");
  } else {
    return undefined;
  }

  return { type: "file-edit", runId, path, diff, status, raw };
}

/** Tool-result content (string or block array) → canonical ContentBlock[]. */
function normalizeToolResult(content: unknown): ContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) {
    return content.map((x): ContentBlock => {
      if (x && typeof x === "object" && (x as { type?: string }).type === "text") {
        return { type: "text", text: String((x as { text?: unknown }).text ?? "") };
      }
      return { type: "text", text: JSON.stringify(x) };
    });
  }
  return [{ type: "text", text: content == null ? "" : String(content) }];
}

interface ClaudeResultLine {
  type: "result";
  subtype?: string;
  is_error?: boolean;
  result?: unknown;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function mapUsage(ev: ClaudeResultLine): Partial<Usage> | undefined {
  const usage: Partial<Usage> = {};
  const u = ev.usage;
  if (u) {
    usage.inputTokens = u.input_tokens ?? 0;
    usage.outputTokens = u.output_tokens ?? 0;
    if (u.cache_read_input_tokens != null) usage.cacheReadTokens = u.cache_read_input_tokens;
    if (u.cache_creation_input_tokens != null) usage.cacheWriteTokens = u.cache_creation_input_tokens;
  }
  if (typeof ev.total_cost_usd === "number") usage.reportedCostUsd = ev.total_cost_usd;
  return Object.keys(usage).length ? usage : undefined;
}

function handleEvent(
  ev: unknown,
  state: StreamState,
  push: (c: StreamChunk) => void,
  cfg: ClaudeCodeConfig,
): void {
  const e = ev as Record<string, unknown>;
  const runId = state.runId;

  switch (e.type) {
    case "system": {
      if (e.subtype !== "init") return;
      const sessionId = typeof e.session_id === "string" ? e.session_id : "";
      state.sessionId = sessionId;
      const chunk: Extract<StreamChunk, { type: "session-init" }> = { type: "session-init", runId, raw: e };
      if (sessionId) chunk.providerSessionId = sessionId;
      if (Array.isArray(e.tools)) chunk.tools = (e.tools as unknown[]).map(String);
      if (Array.isArray(e.mcp_servers)) {
        chunk.mcpServers = (e.mcp_servers as unknown[])
          .map((m) => (typeof m === "string" ? m : (m as { name?: string })?.name))
          .filter((n): n is string => typeof n === "string");
      }
      push(chunk);
      return;
    }

    case "stream_event": {
      const inner = e.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | undefined;
      if (inner?.type === "content_block_delta") {
        const d = inner.delta;
        if (d?.type === "text_delta") {
          push({ type: "text-delta", runId, text: d.text ?? "", channel: "answer", raw: e });
        } else if (d?.type === "thinking_delta") {
          push({ type: "reasoning-delta", runId, text: d.thinking ?? "", raw: e });
        }
      }
      return;
    }

    case "assistant": {
      const content = (e.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const raw of content) {
        const b = raw as { type?: string; text?: string };
        if (b.type === "text") {
          // Fallback for when `--include-partial-messages` stream_event deltas
          // never arrived (e.g. an older CLI build, or a run that only emits
          // the final assistant message): the final answer text is still
          // present in this content block, so emit it here instead of
          // silently dropping the answer. Guarded on `emittedContent` so a run
          // that DID stream deltas does not get the same text pushed twice.
          if (!state.emittedContent && typeof b.text === "string" && b.text) {
            push({ type: "text-delta", runId, text: b.text, channel: "answer", raw });
          }
          continue;
        }
        if (b.type !== "tool_use") continue;
        const tu = raw as ToolUseBlock;
        push({ type: "tool-call-start", runId, id: tu.id, name: tu.name, raw });
        push({ type: "tool-call-end", runId, id: tu.id, input: tu.input, raw });
        state.toolUses.push({ id: tu.id, name: tu.name, input: tu.input });
        const fe = toFileEdit(runId, tu, cfg.permissionMode ?? "default", raw);
        if (fe) push(fe);
      }
      return;
    }

    case "user": {
      const content = (e.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const raw of content) {
        const b = raw as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (b.type !== "tool_result") continue;
        const chunk: Extract<StreamChunk, { type: "tool-result" }> = {
          type: "tool-result",
          runId,
          toolCallId: b.tool_use_id ?? "",
          content: normalizeToolResult(b.content),
          raw,
        };
        if (b.is_error !== undefined) chunk.isError = b.is_error;
        push(chunk);
      }
      return;
    }

    case "result": {
      const line = e as unknown as ClaudeResultLine;
      const usage = mapUsage(line);
      if (usage) push({ type: "usage", runId, usage, raw: line.usage ?? e });
      if (typeof line.result === "string") state.finalText = line.result;
      const isError =
        line.is_error === true || (typeof line.subtype === "string" && line.subtype.startsWith("error"));
      // On error the claude `result` line's `subtype` is often just "success"
      // (e.g. a model_not_found still reports subtype:"success" with
      // is_error:true). Prefer the human-readable `result` message so the user
      // sees the real cause instead of a meaningless "error: success".
      const subtype = isError
        ? typeof line.result === "string" && line.result
          ? line.result
          : line.subtype
        : line.subtype;
      state.terminal = { ok: !isError, ...(subtype !== undefined ? { subtype } : {}) };
      return;
    }

    default:
      return;
  }
}

// ── Capabilities ──────────────────────────────────────────────────────────────

function buildModelInfos(modelMap: Record<string, string> | undefined): ModelInfo[] {
  if (!modelMap) return [];
  const byNative = new Map<string, string[]>();
  for (const [alias, native] of Object.entries(modelMap)) {
    const list = byNative.get(native) ?? [];
    if (alias !== native) list.push(alias);
    byNative.set(native, list);
  }
  const infos: ModelInfo[] = [];
  for (const [native, aliases] of byNative) {
    const info: ModelInfo = { id: native, modalities: ["text", "image"] };
    if (aliases.length > 0) info.aliases = aliases;
    infos.push(info);
  }
  return infos;
}

/** Union two catalogs by id, preserving order (`base` first, then new ids). */
function unionModels(base: ModelInfo[], extra: ModelInfo[]): ModelInfo[] {
  const seen = new Set(base.map((m) => m.id));
  const out = [...base];
  for (const m of extra) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
    }
  }
  return out;
}

// ── Real model discovery ─────────────────────────────────────────────────────

/**
 * Matches the `Available:` clause of the `claude` CLI's own `/model` reply,
 * e.g. (real output, `claude -p "/model"`, 2026):
 *
 *   Current model: Opus 5 (1M context) (effort: xhigh)
 *   Usage: /model <name>. Available: sonnet, opus, haiku, fable, best,
 *          sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full
 *          model ID.
 *
 * Captures everything between "Available:" and the final period. The clause
 * itself is one line in the real reply (only the "Current model:"/"Usage:"
 * split is a real newline), but `[\s\S]` tolerates a wrapped one too.
 */
const AVAILABLE_RE = /Available:\s*([\s\S]*?)\.\s*$/;

/**
 * Parse the `claude -p "/model"` reply text into the exact set of values the
 * CLI itself says `--model`/`/model` accepts. Pure and exported for direct
 * (offline) unit coverage of the parser separate from the subprocess plumbing.
 * The trailing "…or a full model ID" filler names no model and is dropped;
 * so is anything empty after trimming.
 */
export function parseClaudeModelReply(replyText: string): string[] {
  const m = AVAILABLE_RE.exec(replyText.trim());
  const captured = m?.[1];
  if (!captured) return [];
  return captured
    .split(",")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0 && !/^or\s/i.test(s));
}

interface ClaudeModelProbeReply {
  result?: unknown;
}

/**
 * Real model discovery for the `claude` CLI: run its own `/model` command
 * (`claude -p "/model" --output-format json`) and parse the `Available:` list
 * it reports back — that IS the CLI telling us what it accepts, not a
 * point-in-time guess baked into this file (the bug this replaces: the prior
 * hardcoded `CLAUDE_CODE_MODELS` array went stale twice and was missing
 * `fable`/`best`/`sonnet[1m]`/`opus[1m]`/`fable[1m]`/`opusplan` entirely).
 *
 * Zero API cost and fast: `/model` is answered by the CLI locally — a real
 * run reports `total_cost_usd:0`/`duration_api_ms:0` in its own JSON reply —
 * so this is safe to run on every uncached `listModels()` call. Bounded by
 * `cfg.listModelsTimeoutMs` (default {@link DEFAULT_PROBE_TIMEOUT_MS}); a
 * timeout, spawn failure, non-zero exit, or unparseable/empty reply THROWS so
 * the caller can tell "we could not ask" apart from "the CLI answered with
 * zero models" and fall back to something honest instead of guessing.
 */
async function probeClaudeCodeModels(cfg: ClaudeCodeConfig): Promise<string[]> {
  const bin = cfg.bin ?? claudeCodeSpec.defaultBin;
  const probe = await runBoundedCapture({
    bin,
    args: ["-p", "/model", "--output-format", "json"],
    ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
    ...(cfg.resolveEnv ? { resolveEnv: cfg.resolveEnv } : {}),
    ...(cfg.spawn ? { spawn: cfg.spawn } : {}),
    timeoutMs: cfg.listModelsTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  });
  if (probe.spawnError) throw new Error(`${bin} not available: ${probe.spawnError.message}`);
  if (probe.timedOut) throw new Error(`${bin} -p "/model" timed out — unknown, not empty`);
  if (probe.exitCode !== 0) throw new Error(`${bin} -p "/model" exited ${probe.exitCode}`);

  let parsed: ClaudeModelProbeReply;
  try {
    parsed = JSON.parse(probe.stdout) as ClaudeModelProbeReply;
  } catch {
    throw new Error(`${bin} -p "/model" returned unparseable output`);
  }
  const text = typeof parsed.result === "string" ? parsed.result : "";
  const ids = parseClaudeModelReply(text);
  if (ids.length === 0) throw new Error(`${bin} -p "/model" reply had no parseable "Available:" list`);
  return ids;
}

// ── Real reasoning-effort discovery ──────────────────────────────────────────

/**
 * Matches the `Usage:` clause of the `claude` CLI's own `/effort` reply, e.g.
 * (real output, `claude -p "/effort" --output-format json`, claude-cli
 * 2.1.220): `"Usage: /effort <low|medium|high|xhigh|max|ultracode|auto>"`.
 *
 * `claude --help`'s own `--effort <level>` documentation lists only five of
 * these seven (`low, medium, high, xhigh, max`) — proof this vocabulary
 * cannot be safely hardcoded even from the CLI's own static help text, only
 * from asking `/effort` directly, exactly the discipline `AVAILABLE_RE`
 * already established for `/model`.
 */
const EFFORT_USAGE_RE = /Usage:\s*\/effort\s*<([^>]+)>/;

/**
 * Parse the `claude -p "/effort"` reply text into the exact set of level
 * names the CLI itself accepts. Pure and exported for direct (offline) unit
 * coverage, mirroring {@link parseClaudeModelReply}.
 */
export function parseClaudeEffortReply(replyText: string): string[] {
  const m = EFFORT_USAGE_RE.exec(replyText.trim());
  const captured = m?.[1];
  if (!captured) return [];
  return captured
    .split("|")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Real reasoning-effort discovery for the `claude` CLI: run its own
 * `/effort` command (`claude -p "/effort" --output-format json`) and parse
 * the `Usage:` clause it reports back — same zero-API-cost, locally-answered
 * slash command as `/model` (a real run reports `total_cost_usd:0`,
 * `duration_ms` in single digits), so this is safe to run on every uncached
 * `listReasoningLevels()` call. Bounded by `cfg.listModelsTimeoutMs`
 * (reused rather than a new config knob — same probe class as `/model`).
 * THROWS on any failure (timeout, spawn error, unparseable/empty reply) so
 * the caller can fall back to "we could not ask" instead of guessing.
 */
async function probeClaudeCodeEffort(cfg: ClaudeCodeConfig): Promise<string[]> {
  const bin = cfg.bin ?? claudeCodeSpec.defaultBin;
  const probe = await runBoundedCapture({
    bin,
    args: ["-p", "/effort", "--output-format", "json"],
    ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
    ...(cfg.resolveEnv ? { resolveEnv: cfg.resolveEnv } : {}),
    ...(cfg.spawn ? { spawn: cfg.spawn } : {}),
    timeoutMs: cfg.listModelsTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  });
  if (probe.spawnError) throw new Error(`${bin} not available: ${probe.spawnError.message}`);
  if (probe.timedOut) throw new Error(`${bin} -p "/effort" timed out — unknown, not empty`);
  if (probe.exitCode !== 0) throw new Error(`${bin} -p "/effort" exited ${probe.exitCode}`);

  let parsed: ClaudeModelProbeReply;
  try {
    parsed = JSON.parse(probe.stdout) as ClaudeModelProbeReply;
  } catch {
    throw new Error(`${bin} -p "/effort" returned unparseable output`);
  }
  const text = typeof parsed.result === "string" ? parsed.result : "";
  const levels = parseClaudeEffortReply(text);
  if (levels.length === 0) throw new Error(`${bin} -p "/effort" reply had no parseable "Usage:" list`);
  return levels;
}

// ── Spec + factory ────────────────────────────────────────────────────────────

const claudeCodeSpec: CliSpec<ClaudeCodeConfig> = {
  id: PROVIDER_ID,
  label: "Claude Code (CLI)",
  defaultBin: "claude",
  versionArgs: ["--version"],
  capabilities: (cfg): Capabilities => ({
    models: buildModelInfos(cfg.modelMap),
    streaming: true,
    tools: true,
    parallelToolCalls: true,
    vision: true,
    structuredOutput: false,
    reasoning: true,
    systemPrompt: true,
    fileEdit: true,
    shellExec: true,
    git: true,
    approvalGate: true,
    mcp: true,
    cancel: "process-kill",
  }),
  resolveModel,
  buildArgs,
  handleEvent,
};

/**
 * Create the Claude Code {@link ProviderAdapter}. Auth is delegated to the CLI's
 * own OAuth session (`~/.claude`) unless `cfg.resolveEnv` injects
 * `ANTHROPIC_API_KEY`. Pass `cfg.spawn` / `cfg.bin` to point at a deterministic
 * fake CLI in tests.
 *
 * `listModels()` is wired here (not on the shared `claudeCodeSpec` object)
 * because each adapter instance gets its OWN short-TTL cache
 * ({@link createModelListCache}, 60s default) — a module-level cache would
 * incorrectly share results across adapters built with different `bin`/`cfg`
 * (e.g. the real CLI vs. a test's fake one). This is also what keeps a
 * fast-refreshing picker from spawning `claude` on every open: repeat calls
 * within the TTL are served from memory, not a new subprocess.
 *
 * `probeClaudeCodeModels` never resolves an empty/guessed answer — on any
 * failure (timeout, spawn error, unparseable reply) it throws, and this
 * wrapper catches that and degrades to the config-driven `modelMap` entries
 * only (never the deleted hardcoded catalog) — so a failed probe reads as
 * "we could not ask" rather than a fabricated or falsely-empty catalog.
 * Tagged `source: "provider"` on a genuine probe success, `"fallback"` on
 * degrade (see `ModelListSource`, `@nexuscode/shared`) — surfaced through
 * `listModelsWithSource` (`@nexuscode/core`'s `ProviderAdapter`).
 */
export function createClaudeCodeAdapter(cfg: ClaudeCodeConfig = {}): ProviderAdapter {
  const modelCache: ModelListCache = createModelListCache();
  const effortCache: EffortListCache = createEffortListCache();
  const spec: CliSpec<ClaudeCodeConfig> = {
    ...claudeCodeSpec,
    listModels: (c): Promise<ModelListResult> =>
      modelCache.get(async () => {
        try {
          const ids = await probeClaudeCodeModels(c);
          const probed: ModelInfo[] = ids.map((id) => ({ id, modalities: ["text", "image"] }));
          return { models: unionModels(probed, buildModelInfos(c.modelMap)), source: "provider" };
        } catch {
          return { models: buildModelInfos(c.modelMap), source: "fallback" };
        }
      }),
  };
  const adapter = createSubprocessAdapter(cfg, spec);
  // `listReasoningLevels` gets its OWN cache instance for the same reason
  // `modelCache` does — a module-level cache would leak across adapters built
  // with different `bin`/`cfg` (the real CLI vs. a test's fake one). On any
  // probe failure this degrades to an EMPTY list tagged `"fallback"` rather
  // than a guess: `reasoningSupportedFor`/`applyEffort`
  // (`packages/cli/src/commands.ts`) already treat "adapter implements this
  // method" as "reasoning effort is real here" (see that function's doc), so
  // silently returning nothing on a failed probe — not throwing — is what
  // keeps a transient probe hiccup from turning into a hard command failure;
  // the caller just sees an empty scale and can choose not to render a
  // control for it, or to fall back to `--effort` unvalidated.
  adapter.listReasoningLevels = (): Promise<EffortListResult> =>
    effortCache.get(async () => {
      // `offDisablesReasoning: false` on EVERY branch, success or fallback —
      // a STATIC fact about this adapter's wire, not a probe result: verified
      // live, `claude` already emits real `reasoning` events with ZERO
      // `--effort` passed (it has its own persistent session default), and
      // `buildArgs` never sends anything that WOULD turn reasoning off — see
      // `EffortListResult.offDisablesReasoning`'s doc.
      try {
        const levels = await probeClaudeCodeEffort(cfg);
        return { levels: levels.map((id) => ({ id })), source: "provider", offDisablesReasoning: false };
      } catch {
        return { levels: [], source: "fallback", offDisablesReasoning: false };
      }
    });
  return adapter;
}

// Re-export types callers commonly need alongside the factory.
export type { CallContext, ChatResult, HealthStatus, ProviderAdapter };
export { buildArgs as buildClaudeCodeArgs };
