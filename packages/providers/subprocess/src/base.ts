/**
 * The shared subprocess-adapter base.
 *
 * It owns everything that is identical across every wrapped coding CLI:
 *   • spawn the CLI (injectable {@link SpawnFn}),
 *   • stream stdout line-by-line as NDJSON,
 *   • honor `ctx.signal` (SIGINT → 2s grace → SIGTERM; reap the child in a
 *     `finally` so no `claude`/`codex` is ever orphaned),
 *   • apply the load-bearing completion/error rules (authoritative terminal
 *     `result` line; parse-error → `error` chunk but keep consuming;
 *     empty-output soft failure).
 *
 * Everything CLI-specific — the argv, the NDJSON event schema, and the declared
 * capabilities — lives in a per-CLI {@link CliSpec}. Adding a new coding CLI is
 * a new spec plus a config type, never an edit to this file (mirrors master-plan
 * §4.8 / §4.12).
 */

import readline from "node:readline";
import type {
  CallContext,
  ChatResult,
  HealthStatus,
  ProviderAdapter,
  TransportKind,
} from "@nexuscode/core";
import type {
  Capabilities,
  ChatRequest,
  ContentBlock,
  FinishReason,
  Message,
  ModelInfo,
  StreamChunk,
  Usage,
} from "@nexuscode/shared";
import { AdapterError } from "@nexuscode/shared";
import { defaultSpawn, type SpawnedChild, type SpawnFn } from "./spawn.js";

const CLI_TRANSPORT: TransportKind = "cli-subprocess";

/** Field-name substrings that mark an env var as secret, regardless of provider. */
const SECRET_ENV_NAME_RE = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

/** Provider-name prefixes whose env vars are secret-adjacent (base URLs aside). */
const SECRET_ENV_PREFIX_RE =
  /^(ANTHROPIC|OPENAI|XAI|GROQ|GOOGLE|GEMINI|AWS|AZURE|MISTRAL|DEEPSEEK|TOGETHER|NVIDIA|OPENROUTER|HF|HUGGINGFACE)/i;

/**
 * Build a scrubbed copy of `env` with secret-shaped variable NAMES removed
 * (case-insensitive `KEY`/`TOKEN`/`SECRET`/`PASSWORD`/`PASSWD`/`CREDENTIAL`
 * substrings, and known provider-name prefixes). Everything else — `PATH`,
 * `HOME`, etc. — survives untouched.
 *
 * Mirrors `@nexuscode/tools`'s `scrubSecretEnv` (same regexes, same contract).
 * Duplicated rather than imported so this lean provider package (only
 * `@nexuscode/core` + `@nexuscode/shared`) does not pick up a new dependency on
 * the tools subsystem — a different architectural layer — for one small helper.
 */
function scrubSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_NAME_RE.test(k) || SECRET_ENV_PREFIX_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Default wall-clock timeout for the `health()` `--version` probe. */
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/** Config every subprocess adapter accepts. Per-CLI configs extend this. */
export interface SubprocessConfig {
  /** Path/name of the CLI binary. Defaults to the spec's `defaultBin`. */
  bin?: string;
  /** Working directory for the child. */
  cwd?: string;
  /** Injectable spawn (tests / `execa`). Defaults to `node:child_process`. */
  spawn?: SpawnFn;
  /**
   * Lazily resolves extra env for the child (e.g. `ANTHROPIC_API_KEY`). Merged
   * over `process.env`. Omit to rely on the CLI's own OAuth session.
   */
  resolveEnv?: () => Promise<NodeJS.ProcessEnv>;
  /** Logical model id → native CLI model id. */
  modelMap?: Record<string, string>;
  /** Extra raw argv appended verbatim (escape hatch for un-modeled flags). */
  extraArgs?: string[];
  /**
   * Grace period (ms) between the SIGINT sent on abort and the SIGTERM
   * escalation that force-reaps a child ignoring SIGINT. Defaults to 2000.
   */
  killGraceMs?: number;
  /**
   * Wall-clock timeout (ms) for the `health()` `--version` probe child. On
   * expiry the child is SIGTERM'd and `health()` resolves `ok:false` — a hung
   * probe must never leak a process or hang the caller. Defaults to 5000.
   */
  healthTimeoutMs?: number;
}

/**
 * Mutable per-stream accumulator. A {@link CliSpec.handleEvent} pushes chunks
 * and records the terminal outcome here; the base synthesizes the single
 * terminal chunk from it after the read loop.
 */
export interface StreamState {
  readonly runId: string;
  /** Provider session id (from the CLI's init line), for `--resume`. */
  sessionId: string;
  /** True once any content chunk (text/reasoning/file-edit) was emitted. */
  emittedContent: boolean;
  /** Concatenated answer text (fallback for the final message). */
  textBuffer: string;
  /** Authoritative final text if the CLI reports one (e.g. `result.result`). */
  finalText?: string;
  /** Tool-use blocks seen, folded into the final assistant message. */
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  /** Usage accumulated from `usage` chunks / the terminal line. */
  finalUsage?: Partial<Usage>;
  /** Set when the CLI emits its authoritative terminal line. */
  terminal?: { ok: boolean; subtype?: string };
}

/** Per-CLI behavior. The only thing that changes between coding CLIs. */
export interface CliSpec<Cfg extends SubprocessConfig> {
  readonly id: string;
  readonly label: string;
  readonly defaultBin: string;
  /** argv for `--version`-style health probe. Default `["--version"]`. */
  readonly versionArgs?: string[];
  capabilities(cfg: Cfg): Capabilities;
  /**
   * Optional real model discovery. A wrapped coding CLI has no models API, so
   * this returns the vendor CLI's curated selectable models (plus any
   * config-driven aliases). The base wraps it so `listModels` never throws —
   * any failure degrades to `capabilities(cfg).models`. Omit to leave the
   * adapter without a `listModels` method.
   */
  listModels?(cfg: Cfg): ModelInfo[] | Promise<ModelInfo[]>;
  /** Resolve the native model id for this request. */
  resolveModel(cfg: Cfg, req: ChatRequest): string;
  /** Build the child's argv from config + request. */
  buildArgs(cfg: Cfg, req: ChatRequest): string[];
  /**
   * Translate one parsed NDJSON event into zero or more chunks (via `push`) and
   * record any terminal outcome onto `state`. Never emits the terminal
   * `run-end`/`error`/`empty_output` chunk itself — the base does that.
   */
  handleEvent(
    ev: unknown,
    state: StreamState,
    push: (chunk: StreamChunk) => void,
    cfg: Cfg,
  ): void;
}

function truncate(s: string, n = 200): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function fullUsage(u: Partial<Usage> | undefined): Usage | undefined {
  if (!u) return undefined;
  return { inputTokens: 0, outputTokens: 0, ...u };
}

function assembleMessage(state: StreamState): Message {
  const content: ContentBlock[] = [];
  const text = state.finalText ?? state.textBuffer;
  if (text) content.push({ type: "text", text });
  for (const t of state.toolUses) {
    content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input });
  }
  return { role: "assistant", content };
}

/**
 * Build a subprocess {@link ProviderAdapter} from a per-CLI {@link CliSpec}.
 */
export function createSubprocessAdapter<Cfg extends SubprocessConfig>(
  cfg: Cfg,
  spec: CliSpec<Cfg>,
): ProviderAdapter {
  const providerId = spec.id;

  async function resolveChildEnv(): Promise<NodeJS.ProcessEnv> {
    // Scrub secret-shaped ambient env (provider API keys, tokens, etc.) before
    // the child ever sees it — a spawned coding CLI must not inherit every
    // credential loaded into THIS process just by asking for `process.env`.
    // The adapter's own `resolveEnv` (e.g. an explicit `ANTHROPIC_API_KEY`) is
    // merged back on top, so the CLI still gets exactly the creds it needs;
    // claude-code/codex's own OAuth session under HOME is untouched either way.
    const base = scrubSecretEnv(process.env);
    if (!cfg.resolveEnv) return base;
    const extra = await cfg.resolveEnv();
    return { ...base, ...extra };
  }

  async function* stream(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamChunk> {
    const runId = ctx.runId;
    const model = spec.resolveModel(cfg, req);
    yield { type: "run-start", runId, adapterId: providerId, model, ts: Date.now() };

    if (ctx.signal.aborted) {
      const error = new AdapterError("cancelled", "aborted", { providerId });
      yield { type: "error", runId, error, retryable: error.retryable };
      return;
    }

    let env: NodeJS.ProcessEnv;
    let args: string[];
    try {
      env = await resolveChildEnv();
      args = spec.buildArgs(cfg, req);
    } catch (e) {
      const error = new AdapterError("transport", `failed to prepare launch: ${String((e as Error)?.message ?? e)}`, {
        providerId,
        cause: e,
      });
      yield { type: "error", runId, error, retryable: error.retryable };
      return;
    }

    const spawnFn: SpawnFn = cfg.spawn ?? defaultSpawn;
    const bin = cfg.bin ?? spec.defaultBin;

    let child;
    try {
      child = spawnFn(bin, args, { cwd: cfg.cwd, env });
    } catch (e) {
      const error = new AdapterError("transport", `spawn failed: ${String((e as Error)?.message ?? e)}`, {
        providerId,
        cause: e,
      });
      yield { type: "error", runId, error, retryable: error.retryable };
      return;
    }

    // Track real process exit independently of `child.killed`. Node flips
    // `killed` to true the instant ANY signal is delivered (SIGINT included),
    // NOT when the process actually exits — so `killed` cannot gate the
    // SIGINT→SIGTERM escalation or the final reap without disabling both. A
    // child that traps/ignores SIGINT would otherwise be orphaned.
    let exited = false;
    void child.done.then(() => {
      exited = true;
    });

    // Abort → SIGINT, 2s grace, SIGTERM. The timer is unref'd so it never keeps
    // the event loop alive on its own.
    const onAbort = (): void => {
      child.kill("SIGINT");
      const t = setTimeout(() => {
        if (!exited) child.kill("SIGTERM");
      }, cfg.killGraceMs ?? 2000);
      t.unref();
    };
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const state: StreamState = {
      runId,
      sessionId: "",
      emittedContent: false,
      textBuffer: "",
      toolUses: [],
    };

    try {
      if (child.stdout) {
        const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
        try {
          for await (const line of rl) {
            if (!line.trim()) continue;

            let ev: unknown;
            try {
              ev = JSON.parse(line);
            } catch {
              // Rule 5: an unparseable line yields a `parse` error chunk but the
              // stream keeps consuming — a single bad line must not abort it.
              const error = new AdapterError("parse", `bad NDJSON: ${truncate(line)}`, { providerId });
              yield { type: "error", runId, error, retryable: false };
              continue;
            }

            const pending: StreamChunk[] = [];
            spec.handleEvent(ev, state, (c) => pending.push(c), cfg);

            for (const c of pending) {
              if (c.type === "text-delta") {
                state.emittedContent = true;
                state.textBuffer += c.text;
              } else if (c.type === "reasoning-delta" || c.type === "file-edit") {
                state.emittedContent = true;
              } else if (c.type === "usage") {
                state.finalUsage = { ...state.finalUsage, ...c.usage };
              }
              yield c;
            }
          }
        } finally {
          rl.close();
        }
      }

      const exit = await child.done;

      // Async spawn failure (e.g. ENOENT) surfaces here, not as a throw.
      if (exit.error && !ctx.signal.aborted) {
        const error = new AdapterError("transport", `spawn failed: ${exit.error.message}`, {
          providerId,
          cause: exit.error,
        });
        yield { type: "error", runId, error, retryable: error.retryable };
        return;
      }

      const usage = fullUsage(state.finalUsage);

      // ── Completion / error rules (master-plan §4.8) ──────────────────────────
      if (state.terminal) {
        // Rule 1: the terminal `result` line is authoritative.
        if (!state.terminal.ok) {
          const error = new AdapterError("cli_exit", state.terminal.subtype ?? "cli error", {
            providerId,
            exitCode: exit.exitCode,
          });
          yield { type: "error", runId, error, retryable: false };
        } else if (!state.emittedContent) {
          // Rule 6: success with zero content is an empty_output soft failure.
          const error = new AdapterError("empty_output", "completed with no content", { providerId });
          yield { type: "error", runId, error, retryable: false };
        } else {
          yield endChunk(state, usage);
        }
      } else if (ctx.signal.aborted) {
        // Rule 4: aborted before a terminal line.
        const error = new AdapterError("cancelled", "aborted", { providerId });
        yield { type: "error", runId, error, retryable: false };
      } else if (exit.exitCode !== 0) {
        // Rule 3: non-zero (or signalled/null) exit with no `result` line.
        const error = new AdapterError("cli_exit", `exit ${exit.exitCode}`, {
          providerId,
          exitCode: exit.exitCode,
        });
        yield { type: "error", runId, error, retryable: false };
      } else if (!state.emittedContent) {
        // Rule 2 + 6: clean exit, no `result`, no content → empty completion.
        const error = new AdapterError("empty_output", "exited cleanly with no content", { providerId });
        yield { type: "error", runId, error, retryable: false };
      } else {
        // Clean exit with content but no explicit terminal line.
        yield endChunk(state, usage);
      }
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      // Never leak a child: reap anything that has not actually exited. Gated on
      // real exit (`exited`), not `child.killed` — a prior SIGINT already set
      // `killed` true, which would otherwise suppress this force-kill.
      if (!exited) child.kill("SIGTERM");
    }

    function endChunk(s: StreamState, u: Usage | undefined): Extract<StreamChunk, { type: "run-end" }> {
      const finishReason: FinishReason = "stop";
      const chunk: Extract<StreamChunk, { type: "run-end" }> = {
        type: "run-end",
        runId: s.runId,
        finishReason,
        message: assembleMessage(s),
        ts: Date.now(),
      };
      if (u) chunk.usage = u;
      if (s.sessionId) chunk.providerSessionId = s.sessionId;
      return chunk;
    }
  }

  async function chat(req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
    let message: Message | undefined;
    let usage: Usage | undefined;
    let finishReason: FinishReason = "stop";

    for await (const chunk of stream(req, ctx)) {
      if (chunk.type === "run-end") {
        message = chunk.message;
        usage = chunk.usage;
        finishReason = chunk.finishReason;
      } else if (chunk.type === "error") {
        throw chunk.error;
      }
    }

    if (!message) {
      throw new AdapterError("empty_output", `${providerId} produced no output`, { providerId });
    }
    const result: ChatResult = { message, finishReason };
    if (usage) result.usage = usage;
    return result;
  }

  const capabilities = async (): Promise<Capabilities> => spec.capabilities(cfg);

  /**
   * Model discovery for a wrapped CLI: the spec's curated selectable models.
   * Present only when the spec supplies `listModels`. Never throws — any failure
   * degrades to the declared `capabilities().models`.
   */
  const listModels = spec.listModels
    ? async (): Promise<ModelInfo[]> => {
        try {
          return await spec.listModels!(cfg);
        } catch {
          return spec.capabilities(cfg).models;
        }
      }
    : undefined;

  /**
   * Cheap readiness probe via `<bin> --version`. Returns `ok:false` when the CLI
   * is not on PATH (or errors) — it never throws (master-plan: health must not
   * throw so registration degrades gracefully).
   */
  const health = async (ctx: CallContext): Promise<HealthStatus> => {
    const bin = cfg.bin ?? spec.defaultBin;
    const timeoutMs = cfg.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    let child: SpawnedChild | undefined;
    // Real-exit tracking (not `child.killed`, which flips true the instant a
    // signal is *delivered*, not when the process actually exits) — mirrors
    // the same reap-safety pattern `stream()` uses.
    let exited = false;
    let timedOut = false;
    const reap = (): void => {
      if (child && !exited) child.kill("SIGTERM");
    };

    try {
      const env = await resolveChildEnv();
      const spawnFn: SpawnFn = cfg.spawn ?? defaultSpawn;
      child = spawnFn(bin, spec.versionArgs ?? ["--version"], { cwd: cfg.cwd, env });
      void child.done.then(() => {
        exited = true;
      });

      let out = "";
      if (child.stdout) child.stdout.on("data", (d: unknown) => { out += String(d); });

      ctx.signal.addEventListener("abort", reap, { once: true });
      if (ctx.signal.aborted) reap();

      const timer = setTimeout(() => {
        timedOut = true;
        reap();
      }, timeoutMs);
      timer.unref?.();

      try {
        const exit = await child.done;
        if (ctx.signal.aborted) return { ok: false, detail: "aborted" };
        if (timedOut) return { ok: false, detail: `${bin} --version timed out after ${timeoutMs}ms` };
        if (exit.error) return { ok: false, detail: `${bin} not found on PATH` };
        if (exit.exitCode === 0) return { ok: true, detail: out.trim() || `${bin} available` };
        return { ok: false, detail: `${bin} --version exited ${exit.exitCode}` };
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", reap);
      }
    } catch (e) {
      return { ok: false, detail: `${bin} not available: ${String((e as Error)?.message ?? e)}` };
    } finally {
      // Never leak a child on any path (success, error, timeout, or abort):
      // reap anything that has not actually exited.
      reap();
    }
  };

  const dispose = async (): Promise<void> => {
    /* no pooled state to release; children are reaped per-stream. */
  };

  const adapter: ProviderAdapter = {
    id: providerId,
    label: spec.label,
    transport: CLI_TRANSPORT,
    capabilities,
    chat,
    stream,
    health,
    dispose,
  };
  if (listModels) adapter.listModels = listModels;
  return adapter;
}
