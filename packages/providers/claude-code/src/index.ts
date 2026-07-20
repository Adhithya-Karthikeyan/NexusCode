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
  ModelInfo,
  StreamChunk,
  Usage,
} from "@nexuscode/shared";
import { textOf } from "@nexuscode/shared";
import {
  createSubprocessAdapter,
  replaceDiff,
  writeDiff,
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

function buildArgs(cfg: ClaudeCodeConfig, req: ChatRequest): string[] {
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
  if (req.system) args.push("--append-system-prompt", req.system);
  for (const d of cfg.addDirs ?? []) args.push("--add-dir", d);
  if (cfg.mcpConfig) args.push("--mcp-config", cfg.mcpConfig);

  if (cfg.resume) args.push("--resume", cfg.resume);
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

/**
 * The models the `claude` CLI can select. `"default"` maps to the CLI's own
 * configured default; the short aliases (`sonnet`/`opus`/`haiku`) and the pinned
 * ids are all accepted by `claude --model <id>`. Used by
 * {@link ProviderAdapter.listModels}: a wrapped CLI has no models API, so this
 * curated vendor catalog IS the answer (there is no live endpoint to prefer).
 */
export const CLAUDE_CODE_MODELS: ModelInfo[] = [
  { id: "default", aliases: ["(default)"], modalities: ["text", "image"] },
  { id: "sonnet", modalities: ["text", "image"] },
  { id: "opus", modalities: ["text", "image"] },
  { id: "haiku", modalities: ["text", "image"] },
  { id: "claude-opus-4-1", modalities: ["text", "image"] },
  { id: "claude-sonnet-4-5", modalities: ["text", "image"] },
  { id: "claude-3-7-sonnet-latest", modalities: ["text", "image"] },
  { id: "claude-3-5-haiku-latest", modalities: ["text", "image"] },
];

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
  // Curated vendor catalog unioned with any config-driven modelMap entries.
  listModels: (cfg): ModelInfo[] => unionModels(CLAUDE_CODE_MODELS, buildModelInfos(cfg.modelMap)),
  resolveModel,
  buildArgs,
  handleEvent,
};

/**
 * Create the Claude Code {@link ProviderAdapter}. Auth is delegated to the CLI's
 * own OAuth session (`~/.claude`) unless `cfg.resolveEnv` injects
 * `ANTHROPIC_API_KEY`. Pass `cfg.spawn` / `cfg.bin` to point at a deterministic
 * fake CLI in tests.
 */
export function createClaudeCodeAdapter(cfg: ClaudeCodeConfig = {}): ProviderAdapter {
  return createSubprocessAdapter(cfg, claudeCodeSpec);
}

// Re-export types callers commonly need alongside the factory.
export type { CallContext, ChatResult, HealthStatus, ProviderAdapter };
export { buildArgs as buildClaudeCodeArgs };
