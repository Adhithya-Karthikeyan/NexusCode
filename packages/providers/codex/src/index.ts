/**
 * @nexuscode/provider-codex — OpenAI Codex CLI driven headlessly via
 * `codex exec --json` and normalized into the canonical {@link StreamChunk}
 * union. Same subprocess base as Claude Code (spawn, line-streaming,
 * SIGINT→SIGTERM cancellation, child reaping, completion/error rules); only the
 * argv and the event-name map change (master-plan §4.8 / §4.12).
 *
 * ── ASSUMPTIONS (probe defensively) ──────────────────────────────────────────
 * The Codex CLI's `--json` schema is less formally documented than Claude
 * Code's and has shifted across versions. This mapper assumes the codex-rs
 * event-log shape, where each stdout line is a JSON object that is EITHER a
 * bare event `{type, …}` OR an envelope `{id, msg:{type, …}}` (we unwrap `msg`
 * when present). The recognized `type`s below are best-effort; any unrecognized
 * event is ignored (its `raw` still survives via the base's audit passthrough).
 * Flags/event-names should be re-probed via `codex exec --help` at registration
 * and, if they differ, remapped here — no base changes required.
 *
 *   session_configured / session.created        → session-init
 *   agent_message_delta (delta)                  → text-delta
 *   agent_message (message, non-delta)           → final text (authoritative)
 *   agent_reasoning_delta / reasoning            → reasoning-delta
 *   exec_command_begin (call_id, command)        → tool-call-start + tool-call-end
 *   exec_command_end (call_id, stdout/exit_code) → tool-result
 *   patch_apply_begin / apply_patch / turn_diff  → file-edit
 *   token_count / usage                          → usage
 *   task_complete / turn.completed               → terminal (success)
 *   error / stream_error                         → terminal (error)
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
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
  writeDiff,
  runBoundedCapture,
  DEFAULT_PROBE_TIMEOUT_MS,
  type CliSpec,
  type StreamState,
  type SubprocessConfig,
} from "@nexuscode/provider-subprocess";

export const PROVIDER_ID = "codex";

export type CodexApprovalMode = "untrusted" | "on-failure" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** Static configuration for {@link createCodexAdapter}. */
export interface CodexConfig extends SubprocessConfig {
  /** `--ask-for-approval` / `-a` policy. */
  approvalMode?: CodexApprovalMode;
  /** `--sandbox` / `-s` policy. */
  sandbox?: CodexSandboxMode;
  /** Skip all git-safety prompts: `--skip-git-repo-check`. */
  skipGitRepoCheck?: boolean;
  /** `--cd` working root for the agent. */
  workdir?: string;
  /** Resume a prior Codex thread (`codex exec … resume <id> <prompt>`). */
  resume?: string;
}

// ── Argv ────────────────────────────────────────────────────────────────────────

function promptOf(req: ChatRequest): string {
  const users = req.messages.filter((m) => m.role === "user");
  const last = users[users.length - 1];
  if (last) return textOf(last);
  return req.messages.map(textOf).join("\n\n");
}

function resolveModel(cfg: CodexConfig, req: ChatRequest): string {
  return cfg.modelMap?.[req.model] ?? req.model;
}

function buildArgs(cfg: CodexConfig, req: ChatRequest, ctx?: CallContext): string[] {
  // `codex exec` is the non-interactive subcommand; `--json` emits JSONL events.
  const args: string[] = ["exec", "--json"];

  const model = resolveModel(cfg, req);
  // `"default"` is NexusCode's own sentinel for "let the CLI use its own
  // configured model" (see `listModels` below) — unlike claude-code's own
  // `/model`, codex's `-m/--model` takes a free-form string with NO verified
  // "default" keyword, so passing it through literally as `--model default`
  // would send codex a model id that isn't real. Omitting `--model` entirely
  // lets codex fall back to `~/.codex/config.toml`'s own `model`, which is
  // exactly what picking "default" is supposed to mean.
  if (model && model !== "default") args.push("--model", model);
  if (cfg.sandbox) args.push("--sandbox", cfg.sandbox);
  if (cfg.approvalMode) args.push("--ask-for-approval", cfg.approvalMode);
  if (cfg.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (cfg.workdir) args.push("--cd", cfg.workdir);
  // Real wire path for reasoning effort: codex has no dedicated flag (verified
  // against `codex exec --help`, codex-cli 0.145.0) — the ONLY way to set it
  // per-run is `-c model_reasoning_effort=<value>`, the same config-override
  // mechanism `~/.codex/config.toml`'s own `model_reasoning_effort` key uses
  // (confirmed live: an invalid value here surfaces the model's real
  // `reasoning.effort` enum straight from the API's own validation error —
  // see `probeCodexEffort`). `req.reasoning.effort` carries whatever
  // provider-native level name this adapter's own `listReasoningLevels`
  // (`probeCodexEffort`) reported as valid for the resolved model — sent
  // verbatim. `enabled: false` omits the override entirely so the run falls
  // back to whatever the user already has configured in `config.toml`,
  // exactly like omitting `--model` falls back to codex's own default.
  if (req.reasoning?.enabled && req.reasoning.effort) {
    args.push("-c", `model_reasoning_effort=${req.reasoning.effort}`);
  }
  for (const extra of cfg.extraArgs ?? []) args.push(extra);

  const resume = cfg.resume ?? ctx?.providerSessionId;
  if (resume) args.push("resume", resume);
  // The prompt is a positional trailing arg (after the resume id when present).
  args.push(promptOf(req));
  return args;
}

// ── JSON events → StreamChunk ─────────────────────────────────────────────────

/** Unwrap the `{id,msg:{…}}` envelope if present; else return the object as-is. */
function unwrap(ev: Record<string, unknown>): Record<string, unknown> {
  const msg = ev.msg;
  if (msg && typeof msg === "object") return msg as Record<string, unknown>;
  return ev;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function normalizeExecResult(m: Record<string, unknown>): ContentBlock[] {
  const parts: string[] = [];
  if (typeof m.stdout === "string" && m.stdout) parts.push(m.stdout);
  if (typeof m.stderr === "string" && m.stderr) parts.push(m.stderr);
  if (parts.length === 0 && m.output != null) parts.push(String(m.output));
  return [{ type: "text", text: parts.join("\n") }];
}

function mapUsage(m: Record<string, unknown>): Partial<Usage> | undefined {
  // codex reports `{input_tokens, output_tokens, ...}` under `token_count`/`usage`,
  // sometimes nested under `info`/`usage`.
  const src = (m.usage ?? m.info ?? m) as Record<string, unknown>;
  const input = src.input_tokens ?? src.prompt_tokens ?? src.total_input_tokens;
  const output = src.output_tokens ?? src.completion_tokens ?? src.total_output_tokens;
  if (input == null && output == null) return undefined;
  const usage: Partial<Usage> = {
    inputTokens: typeof input === "number" ? input : 0,
    outputTokens: typeof output === "number" ? output : 0,
  };
  const cached = src.cached_input_tokens ?? src.cache_read_input_tokens;
  if (typeof cached === "number") usage.cacheReadTokens = cached;
  const reasoning = src.reasoning_output_tokens ?? src.reasoning_tokens;
  if (typeof reasoning === "number") usage.reasoningTokens = reasoning;
  return usage;
}

/**
 * Newer codex-rs (`thread`/`turn`/`item` model) wraps every unit of work in an
 * `item.started` / `item.updated` / `item.completed` envelope whose real kind is
 * `item.type`. Translate that inner item into chunks. Text-bearing items
 * (`agent_message`, `reasoning`) are emitted only on `item.completed` — the
 * authoritative, fully-assembled form — so partial `started`/`updated` frames
 * never double-emit. Tool/exec items emit a start on first sight and a result on
 * completion.
 */
function handleItem(
  envType: string,
  item: Record<string, unknown>,
  state: StreamState,
  push: (c: StreamChunk) => void,
  runId: string,
  ev: unknown,
): void {
  const kind = str(item.type);
  const completed = envType === "item.completed";
  switch (kind) {
    case "agent_message":
    case "assistant_message": {
      if (!completed) return;
      const text = str(item.text) || str(item.message);
      if (!text) return;
      // The item schema delivers the answer as ONE atomic `item.completed` — it
      // never streams `agent_message_delta` frames — so emitting it as a
      // text-delta cannot double up prior answer text. Always stream it (even
      // when reasoning/tool items already set `emittedContent`) so the answer
      // lands in the answer channel and the assembled message, not just as a
      // silent `finalText` fallback.
      push({ type: "text-delta", runId, text, channel: "answer", raw: ev });
      return;
    }
    case "reasoning": {
      if (!completed) return;
      const text = str(item.text) || str(item.reasoning) || str(item.summary);
      if (text) push({ type: "reasoning-delta", runId, text, raw: ev });
      return;
    }
    case "command_execution": {
      const id = str(item.id) || `exec_${state.toolUses.length}`;
      const command = Array.isArray(item.command)
        ? (item.command as unknown[]).map(String).join(" ")
        : str(item.command);
      if (!completed) {
        const input = { command };
        push({ type: "tool-call-start", runId, id, name: "shell", raw: ev });
        push({ type: "tool-call-end", runId, id, input, raw: ev });
        state.toolUses.push({ id, name: "shell", input });
        return;
      }
      const out = str(item.aggregated_output) || str(item.output) || str(item.stdout);
      const isError = typeof item.exit_code === "number" && item.exit_code !== 0;
      const chunk: Extract<StreamChunk, { type: "tool-result" }> = {
        type: "tool-result",
        runId,
        toolCallId: id,
        content: [{ type: "text", text: out }],
        raw: ev,
      };
      if (isError) chunk.isError = true;
      push(chunk);
      return;
    }
    case "mcp_tool_call": {
      const id = str(item.id) || `mcp_${state.toolUses.length}`;
      const name = `${str(item.server)}:${str(item.tool)}`;
      if (!completed) {
        const input = (item.arguments ?? {}) as unknown;
        push({ type: "tool-call-start", runId, id, name, raw: ev });
        push({ type: "tool-call-end", runId, id, input, raw: ev });
        state.toolUses.push({ id, name, input });
        return;
      }
      const err = item.error as Record<string, unknown> | null | undefined;
      const isError = err != null || str(item.status) === "failed";
      const resultText = err
        ? str(err.message) || "mcp tool error"
        : typeof item.result === "string"
          ? item.result
          : item.result != null
            ? JSON.stringify(item.result)
            : "";
      const chunk: Extract<StreamChunk, { type: "tool-result" }> = {
        type: "tool-result",
        runId,
        toolCallId: id,
        content: [{ type: "text", text: resultText }],
        raw: ev,
      };
      if (isError) chunk.isError = true;
      push(chunk);
      return;
    }
    case "file_change":
    case "patch": {
      if (!completed) return;
      const changes = (item.changes ?? item.files) as Record<string, unknown> | undefined;
      if (changes && typeof changes === "object") {
        for (const [path, val] of Object.entries(changes)) {
          const content = typeof val === "string" ? val : str((val as Record<string, unknown>)?.content);
          push({ type: "file-edit", runId, path, diff: writeDiff(path, content), status: "applied", raw: ev });
        }
        return;
      }
      const unified = str(item.unified_diff) || str(item.diff);
      if (unified) {
        const path = str(item.path) || str(item.file_path) || "(patch)";
        push({ type: "file-edit", runId, path, diff: unified, status: "applied", raw: ev });
      }
      return;
    }
    default:
      return;
  }
}

function handleEvent(
  ev: unknown,
  state: StreamState,
  push: (c: StreamChunk) => void,
  _cfg: CodexConfig,
): void {
  if (!ev || typeof ev !== "object") return;
  const m = unwrap(ev as Record<string, unknown>);
  const runId = state.runId;
  const type = str(m.type);

  switch (type) {
    // ── Newer codex-rs thread/turn/item schema ──────────────────────────────
    case "thread.started":
    case "thread.created": {
      const sid = str(m.thread_id) || str(m.session_id) || str(m.id);
      if (sid) state.sessionId = sid;
      const chunk: Extract<StreamChunk, { type: "session-init" }> = { type: "session-init", runId, raw: ev };
      if (sid) chunk.providerSessionId = sid;
      push(chunk);
      return;
    }

    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = m.item;
      if (item && typeof item === "object") {
        handleItem(type, item as Record<string, unknown>, state, push, runId, ev);
      }
      return;
    }

    case "turn.started":
      return;

    case "turn.failed":
    case "turn.aborted": {
      const errObj = (m.error ?? m.failure) as Record<string, unknown> | undefined;
      const detail = str(errObj?.message) || str(m.message) || `codex ${type}`;
      state.terminal = { ok: false, subtype: detail };
      return;
    }

    // ── Older codex flat schema ─────────────────────────────────────────────
    case "session_configured":
    case "session.created":
    case "session_created": {
      const sid = str(m.session_id) || str(m.id);
      if (sid) state.sessionId = sid;
      const chunk: Extract<StreamChunk, { type: "session-init" }> = { type: "session-init", runId, raw: ev };
      if (sid) chunk.providerSessionId = sid;
      push(chunk);
      return;
    }

    case "agent_message_delta":
    case "agent_text_delta": {
      const text = str(m.delta) || str(m.text);
      if (text) push({ type: "text-delta", runId, text, channel: "answer", raw: ev });
      return;
    }

    case "agent_message":
    case "agent_text": {
      // Authoritative final text. If deltas already streamed, don't double-emit;
      // just record it as the final message text.
      const text = str(m.message) || str(m.text);
      if (text) {
        if (!state.emittedContent) {
          push({ type: "text-delta", runId, text, channel: "answer", raw: ev });
        } else {
          state.finalText = text;
        }
      }
      return;
    }

    case "agent_reasoning_delta":
    case "reasoning":
    case "agent_reasoning": {
      const text = str(m.delta) || str(m.text) || str(m.reasoning);
      if (text) push({ type: "reasoning-delta", runId, text, raw: ev });
      return;
    }

    case "exec_command_begin":
    case "exec_command": {
      const id = str(m.call_id) || str(m.id) || `exec_${state.toolUses.length}`;
      const command = Array.isArray(m.command) ? (m.command as unknown[]).map(String).join(" ") : str(m.command);
      const input = { command };
      push({ type: "tool-call-start", runId, id, name: "shell", raw: ev });
      push({ type: "tool-call-end", runId, id, input, raw: ev });
      state.toolUses.push({ id, name: "shell", input });
      return;
    }

    case "exec_command_end":
    case "exec_command_output": {
      const id = str(m.call_id) || str(m.id);
      const isError = typeof m.exit_code === "number" && m.exit_code !== 0;
      const chunk: Extract<StreamChunk, { type: "tool-result" }> = {
        type: "tool-result",
        runId,
        toolCallId: id,
        content: normalizeExecResult(m),
        raw: ev,
      };
      if (isError) chunk.isError = true;
      push(chunk);
      return;
    }

    case "patch_apply_begin":
    case "apply_patch":
    case "turn_diff":
    case "patch_apply": {
      // codex reports patches either as a unified diff string or a
      // {path: {content}} map. Emit one file-edit per file.
      const unified = str(m.unified_diff) || str(m.diff);
      const changes = (m.changes ?? m.files) as Record<string, unknown> | undefined;
      if (changes && typeof changes === "object") {
        for (const [path, val] of Object.entries(changes)) {
          const content = typeof val === "string" ? val : str((val as Record<string, unknown>)?.content);
          push({ type: "file-edit", runId, path, diff: writeDiff(path, content), status: "applied", raw: ev });
        }
      } else if (unified) {
        const path = str(m.path) || str(m.file_path) || "(patch)";
        push({ type: "file-edit", runId, path, diff: unified, status: "applied", raw: ev });
      }
      return;
    }

    case "token_count":
    case "usage": {
      const usage = mapUsage(m);
      if (usage) push({ type: "usage", runId, usage, raw: ev });
      return;
    }

    case "task_complete":
    case "task_completed":
    case "turn.completed":
    case "turn_complete": {
      const usage = mapUsage(m);
      if (usage) push({ type: "usage", runId, usage, raw: ev });
      const finalMsg = str(m.last_agent_message) || str(m.message);
      if (finalMsg) state.finalText = finalMsg;
      state.terminal = { ok: true, subtype: type };
      return;
    }

    case "error":
    case "stream_error":
    case "task_error": {
      const detail = str(m.message) || str(m.error) || "codex error";
      state.terminal = { ok: false, subtype: detail };
      return;
    }

    default:
      return;
  }
}

// ── Failure translation ────────────────────────────────────────────────────────

// codex-rs's own wording for its trusted-directory safety check. Matched
// narrowly on BOTH the refusal phrase and the flag it names, not either alone
// — a single generic word ("trusted") would risk swallowing unrelated codex
// failures under this translation, the same over-broad-matcher bug the shared
// redactor's doc comment (`redactDiagnostic`) warns about one layer down.
const TRUSTED_DIR_RE = /not inside a trusted directory/i;
const SKIP_FLAG_RE = /--skip-git-repo-check/i;

/**
 * codex refuses to run outside a git repository unless `--skip-git-repo-check`
 * is passed — codex's own safety check, not ours, and this adapter does not
 * bypass it silently (that would be making the same "quiet decision on the
 * user's behalf" this codebase has deliberately been removing elsewhere). The
 * raw CLI text is accurate but assumes the reader already knows what codex is
 * and what a "trusted directory" means. Translate it into a message that names
 * the actual directory and the two real options, while keeping the original
 * CLI line intact underneath for anyone debugging the launch.
 */
function translateFailure(detail: string, cfg: CodexConfig): string | undefined {
  if (!TRUSTED_DIR_RE.test(detail) || !SKIP_FLAG_RE.test(detail)) return undefined;
  const dir = cfg.workdir ?? cfg.cwd ?? process.cwd();
  return (
    `codex will not run in ${dir} because it is not a git repository. ` +
    `Open a project folder that is a git repo, or run "codex" there yourself once to trust it.\n\n` +
    `(codex said: ${detail})`
  );
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
    const info: ModelInfo = { id: native, modalities: ["text"] };
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
 * `codex` has NO enumerable model list: `-m/--model <MODEL>` takes a
 * free-form string, and neither `codex models` nor `--list-models` exist
 * (verified against `codex --help` / `codex exec --help`, codex-cli 0.145.0).
 * There is nothing here to curate — a plausible-looking id list (the prior
 * `CODEX_MODELS` array: `gpt-5-codex, o4-mini, o3, gpt-4.1,
 * codex-mini-latest`) is exactly the fabrication this replaces; it named ids
 * that do not include what the CLI was actually configured to use.
 *
 * The one thing codex WILL tell us, read-only and offline, is what it is
 * actually configured to run: `codex doctor --json` resolves
 * `~/.codex/config.toml` (plus any `-c`/profile overrides) and reports the
 * result at `checks["config.load"].details.model`. Verified live: it runs in
 * well under a second, needs no `--skip-git-repo-check` (unlike `codex exec`,
 * it is NOT gated on running inside a trusted git directory — confirmed by
 * running it from a plain non-git tmp dir), and touches no model API (it is a
 * diagnostic report, not an agent turn).
 */
export const DEFAULT_MODEL_ID = "default";

interface CodexDoctorReport {
  checks?: Record<string, { details?: Record<string, unknown> }>;
}

/**
 * Read codex's OWN resolved model out of `codex doctor --json` — never a
 * guess. Returns `undefined` on any failure (spawn error, timeout, bad JSON,
 * missing field): the caller then offers ONLY `"default"` rather than
 * fabricating a model id, so "we could not determine the configured model"
 * stays distinguishable from "codex reported no models" (there is never a
 * bare empty catalog here — `"default"` is always a legitimate `--model`
 * omission, see `buildArgs` above). Bounded by `cfg.listModelsTimeoutMs`
 * (default {@link DEFAULT_PROBE_TIMEOUT_MS}) so a hung `codex` can never hang
 * `nexus models`.
 */
async function probeCodexConfiguredModel(cfg: CodexConfig): Promise<string | undefined> {
  const bin = cfg.bin ?? codexSpec.defaultBin;
  const probe = await runBoundedCapture({
    bin,
    args: ["doctor", "--json"],
    ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
    ...(cfg.resolveEnv ? { resolveEnv: cfg.resolveEnv } : {}),
    ...(cfg.spawn ? { spawn: cfg.spawn } : {}),
    timeoutMs: cfg.listModelsTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  });
  if (probe.spawnError || probe.timedOut || probe.exitCode !== 0) return undefined;
  try {
    const report = JSON.parse(probe.stdout) as CodexDoctorReport;
    const model = report.checks?.["config.load"]?.details?.model;
    return typeof model === "string" && model.length > 0 ? model : undefined;
  } catch {
    return undefined;
  }
}

// ── Real reasoning-effort discovery ──────────────────────────────────────────

/**
 * `CODEX_HOME` defaults to `~/.codex` — confirmed live off `codex doctor
 * --json`'s own `config.load.details.CODEX_HOME` field — mirrored here so
 * the config.toml fallback below looks in the exact place codex itself does,
 * honoring an explicit override.
 */
function codexHomeDir(): string {
  const override = process.env.CODEX_HOME;
  return override && override.length > 0 ? override : join(homedir(), ".codex");
}

/**
 * Read the TOP-LEVEL `model_reasoning_effort` key straight out of
 * `$CODEX_HOME/config.toml` — the value the user has actually configured,
 * read WITHOUT spawning codex at all. This is the last-resort fallback for
 * {@link probeCodexEffort}: when codex itself cannot be asked (unreachable,
 * spawn error), this is the only source left for "the value actually
 * configured" — the team's explicit instruction is to surface only that,
 * never invented options, when the full set can't be determined.
 *
 * Deliberately NOT a general TOML parser — just enough targeted scanning to
 * pull one known top-level scalar key, the same "just enough" defensive
 * text-parsing discipline `AVAILABLE_RE`/`TRUSTED_DIR_RE` already use
 * elsewhere in this provider family. Only the text BEFORE the first
 * `[section]` header is scanned, so a `[profiles.x]`-scoped override of the
 * same key name is never mistaken for the global default codex itself would
 * fall back to. Returns `undefined` on any read/parse failure — never a guess.
 */
async function readConfiguredCodexEffort(): Promise<string | undefined> {
  try {
    const text = await readFile(join(codexHomeDir(), "config.toml"), "utf8");
    const topLevel = text.split(/\n\s*\[/)[0] ?? text;
    const m = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"\s*$/m.exec(topLevel);
    return m?.[1];
  } catch {
    return undefined;
  }
}

interface CodexReasoningLevel {
  effort?: unknown;
  description?: unknown;
}

interface CodexModelCatalogEntry {
  slug?: unknown;
  default_reasoning_level?: unknown;
  supported_reasoning_levels?: unknown;
}

interface CodexModelCatalog {
  models?: unknown;
}

/**
 * Real reasoning-effort discovery for `codex`: run `codex debug models
 * --bundled` — the CLI's own documented introspection command ("Render the
 * raw model catalog as JSON") — and read `supported_reasoning_levels`/
 * `default_reasoning_level` for whichever model this run would actually use.
 * `--bundled` skips the catalog-refresh network call and dumps only what
 * shipped with this binary (verified live: well under 30ms, works from a
 * plain non-git directory, needs no auth), so this never depends on network
 * reachability the way a live catalog fetch would.
 *
 * This is intentionally NOT the "send a deliberately invalid
 * `model_reasoning_effort` and scrape the resulting 400" trick — also
 * verified live to work, since the Responses API's own validation error
 * enumerates the full accepted set for the CURRENT model — but that
 * technique requires a real network round-trip against a live, authenticated
 * backend on every uncached probe (slower, costs a real API call, fails
 * outright when offline). `debug models --bundled` answers the same
 * question fully offline, so it is the primary probe; nothing here falls
 * back to the network trick.
 *
 * THROWS on any failure (spawn error, timeout, unparseable JSON, the
 * resolved model missing from the catalog, or a catalog entry with no
 * `supported_reasoning_levels`) so the caller can fall back to
 * {@link readConfiguredCodexEffort} instead of guessing.
 */
async function probeCodexEffort(
  cfg: CodexConfig,
): Promise<{ levels: EffortListResult["levels"]; defaultLevel?: string }> {
  const bin = cfg.bin ?? codexSpec.defaultBin;
  const model = await probeCodexConfiguredModel(cfg);
  if (!model) throw new Error(`${bin}: could not determine the configured model`);

  const probe = await runBoundedCapture({
    bin,
    args: ["debug", "models", "--bundled"],
    ...(cfg.cwd !== undefined ? { cwd: cfg.cwd } : {}),
    ...(cfg.resolveEnv ? { resolveEnv: cfg.resolveEnv } : {}),
    ...(cfg.spawn ? { spawn: cfg.spawn } : {}),
    timeoutMs: cfg.listModelsTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
  });
  if (probe.spawnError) throw new Error(`${bin} not available: ${probe.spawnError.message}`);
  if (probe.timedOut) throw new Error(`${bin} debug models timed out — unknown, not empty`);
  if (probe.exitCode !== 0) throw new Error(`${bin} debug models exited ${probe.exitCode}`);

  let parsed: CodexModelCatalog;
  try {
    parsed = JSON.parse(probe.stdout) as CodexModelCatalog;
  } catch {
    throw new Error(`${bin} debug models returned unparseable output`);
  }
  const entries = Array.isArray(parsed.models) ? (parsed.models as CodexModelCatalogEntry[]) : [];
  const entry = entries.find((e) => e.slug === model);
  if (!entry) throw new Error(`${bin} debug models catalog has no entry for "${model}"`);

  const rawLevels = Array.isArray(entry.supported_reasoning_levels)
    ? (entry.supported_reasoning_levels as CodexReasoningLevel[])
    : [];
  const levels: EffortListResult["levels"] = [];
  for (const l of rawLevels) {
    if (typeof l.effort !== "string" || l.effort.length === 0) continue;
    const info: EffortListResult["levels"][number] = { id: l.effort };
    if (typeof l.description === "string" && l.description.length > 0) info.description = l.description;
    levels.push(info);
  }
  if (levels.length === 0) throw new Error(`${bin} debug models: "${model}" has no supported_reasoning_levels`);

  const defaultLevel = typeof entry.default_reasoning_level === "string" ? entry.default_reasoning_level : undefined;
  return defaultLevel ? { levels, defaultLevel } : { levels };
}

const codexSpec: CliSpec<CodexConfig> = {
  id: PROVIDER_ID,
  label: "Codex (CLI)",
  defaultBin: "codex",
  versionArgs: ["--version"],
  capabilities: (cfg): Capabilities => ({
    models: buildModelInfos(cfg.modelMap),
    streaming: true,
    tools: true,
    parallelToolCalls: false,
    vision: false,
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
  translateFailure,
};

/**
 * Create the Codex {@link ProviderAdapter}. Auth is delegated to the Codex CLI's
 * own login (`OPENAI_API_KEY` or its OAuth) unless `cfg.resolveEnv` injects a
 * key. Pass `cfg.spawn` / `cfg.bin` to point at a deterministic fake CLI.
 *
 * `listModels()` is wired here (not on the shared `codexSpec` object) so each
 * adapter instance gets its OWN short-TTL cache ({@link createModelListCache},
 * 60s default) — a module-level cache would incorrectly share results across
 * adapters built with different `bin`/`cfg` (e.g. the real CLI vs. a test's
 * fake one), and the TTL is what keeps a fast-refreshing picker from spawning
 * `codex doctor` on every open.
 *
 * The result is always `["default", …configured model if resolvable…]` unioned
 * with any config-driven `modelMap` entries — never the deleted fabricated
 * catalog, and never a bare `[]` that could read as "codex verified it has no
 * models" when the truth is just "we couldn't ask".
 */
export function createCodexAdapter(cfg: CodexConfig = {}): ProviderAdapter {
  const modelCache: ModelListCache = createModelListCache();
  const effortCache: EffortListCache = createEffortListCache();
  const spec: CliSpec<CodexConfig> = {
    ...codexSpec,
    listModels: (c): Promise<ModelListResult> =>
      modelCache.get(async () => {
        const configured = await probeCodexConfiguredModel(c);
        const probed: ModelInfo[] = [{ id: DEFAULT_MODEL_ID, modalities: ["text"] }];
        if (configured && configured !== DEFAULT_MODEL_ID) {
          probed.push({ id: configured, modalities: ["text"] });
        }
        const models = unionModels(probed, buildModelInfos(c.modelMap));
        // "provider" only when `codex doctor` actually confirmed a configured
        // model — otherwise this is just the "default" sentinel + config
        // aliases, i.e. "we could not ask", not a verified catalog.
        return { models, source: configured ? "provider" : "fallback" };
      }),
  };
  const adapter = createSubprocessAdapter(cfg, spec);
  // `listReasoningLevels` gets its OWN cache instance for the same reason
  // `modelCache` does — see that field's doc. `probeCodexEffort` throwing
  // means "we could not ask the full catalog"; the fallback then tries
  // `readConfiguredCodexEffort` (a plain file read, no subprocess) so a
  // codex that is reachable-but-catalog-probe-failed still reports the ONE
  // value it is actually configured to use, tagged `"fallback"` — never an
  // invented option, per the team's explicit instruction. Only when BOTH
  // fail does this degrade to an empty list.
  adapter.listReasoningLevels = (): Promise<EffortListResult> =>
    effortCache.get(async () => {
      try {
        const { levels, defaultLevel } = await probeCodexEffort(cfg);
        return defaultLevel ? { levels, defaultLevel, source: "provider" } : { levels, source: "provider" };
      } catch {
        const configured = await readConfiguredCodexEffort();
        if (configured) return { levels: [{ id: configured }], defaultLevel: configured, source: "fallback" };
        return { levels: [], source: "fallback" };
      }
    });
  return adapter;
}

export type { CallContext, ChatResult, HealthStatus, ProviderAdapter };
export { buildArgs as buildCodexArgs };
