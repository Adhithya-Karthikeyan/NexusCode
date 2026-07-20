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
  writeDiff,
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

function buildArgs(cfg: CodexConfig, req: ChatRequest): string[] {
  // `codex exec` is the non-interactive subcommand; `--json` emits JSONL events.
  const args: string[] = ["exec", "--json"];

  const model = resolveModel(cfg, req);
  if (model) args.push("--model", model);
  if (cfg.sandbox) args.push("--sandbox", cfg.sandbox);
  if (cfg.approvalMode) args.push("--ask-for-approval", cfg.approvalMode);
  if (cfg.skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (cfg.workdir) args.push("--cd", cfg.workdir);
  for (const extra of cfg.extraArgs ?? []) args.push(extra);

  // The prompt is a positional trailing arg.
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

/**
 * The models the `codex` CLI can select via `codex exec --model <id>`.
 * `"default"` maps to the CLI's own configured default. Used by
 * {@link ProviderAdapter.listModels}: a wrapped CLI has no models API, so this
 * curated vendor catalog IS the answer (there is no live endpoint to prefer).
 */
export const CODEX_MODELS: ModelInfo[] = [
  { id: "default", aliases: ["(default)"], modalities: ["text"] },
  { id: "gpt-5-codex", modalities: ["text"] },
  { id: "o4-mini", modalities: ["text"] },
  { id: "o3", modalities: ["text"] },
  { id: "gpt-4.1", modalities: ["text"] },
  { id: "codex-mini-latest", modalities: ["text"] },
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
  // Curated vendor catalog unioned with any config-driven modelMap entries.
  listModels: (cfg): ModelInfo[] => unionModels(CODEX_MODELS, buildModelInfos(cfg.modelMap)),
  resolveModel,
  buildArgs,
  handleEvent,
};

/**
 * Create the Codex {@link ProviderAdapter}. Auth is delegated to the Codex CLI's
 * own login (`OPENAI_API_KEY` or its OAuth) unless `cfg.resolveEnv` injects a
 * key. Pass `cfg.spawn` / `cfg.bin` to point at a deterministic fake CLI.
 */
export function createCodexAdapter(cfg: CodexConfig = {}): ProviderAdapter {
  return createSubprocessAdapter(cfg, codexSpec);
}

export type { CallContext, ChatResult, HealthStatus, ProviderAdapter };
export { buildArgs as buildCodexArgs };
