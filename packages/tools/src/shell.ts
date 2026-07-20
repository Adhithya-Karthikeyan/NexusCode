/**
 * `shell_exec` — run a subprocess safely and stream its output.
 *
 * Safety invariants:
 *   - NEVER `shell: true`. The command and its args are passed to `spawn` as an
 *     argv array, so there is no shell to inject into (no globbing, no `;`, no
 *     `$(…)`, no `&&`). A caller who wants a pipeline must invoke a shell
 *     explicitly and own that decision.
 *   - Hard wall-clock timeout: on expiry the child is SIGKILLed and the result
 *     is flagged as an error (isError, ok:false).
 *   - Cancellation via `ctx.signal`: an abort SIGKILLs the child immediately.
 *   - The child's base environment is scrubbed of anything secret-shaped
 *     (`scrubSecretEnv`) before `input.env` is merged on top, so a child never
 *     inherits loaded provider API keys just by asking for `process.env`.
 *   - stdout/stderr are captured up to a combined byte cap (default 8 MiB,
 *     `input.maxOutputBytes`); once exceeded the child is SIGTERMed and the
 *     result is flagged as an error instead of accumulating without bound.
 *   - stdout/stderr are streamed incrementally as `output` ToolEvents; the
 *     terminal `result` carries the summary.
 */

import { spawn } from "node:child_process";
import { resolveInWorkspace } from "./paths.js";
import type { ContentBlock } from "@nexuscode/shared";
import type { Tool, ToolContext, ToolEvent, ToolResult } from "./types.js";
import { asObject, optNumber, optString, optStringArray, optStringRecord, reqString } from "./validate.js";

export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;

/** Combined stdout+stderr cap when the caller doesn't set `maxOutputBytes`. */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

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
 */
export function scrubSecretEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (SECRET_ENV_NAME_RE.test(k) || SECRET_ENV_PREFIX_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

interface ShellInput {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
  env?: Record<string, string>;
  maxOutputBytes: number;
}

function parseShellInput(input: unknown): ShellInput {
  const o = asObject(input);
  const command = reqString(o, "command");
  const args = optStringArray(o, "args") ?? [];
  const cwd = optString(o, "cwd");
  const timeoutMs = optNumber(o, "timeoutMs") ?? DEFAULT_SHELL_TIMEOUT_MS;
  const maxOutputBytes = optNumber(o, "maxOutputBytes") ?? DEFAULT_MAX_OUTPUT_BYTES;
  const env = optStringRecord(o, "env");
  const base: ShellInput = { command, args, timeoutMs, maxOutputBytes };
  if (cwd !== undefined) base.cwd = cwd;
  if (env !== undefined) base.env = env;
  return base;
}

/** A minimal single-consumer async queue used to stream child output events. */
class AsyncQueue<T> {
  private readonly buffer: T[] = [];
  private readonly waiting: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const w = this.waiting.shift();
    if (w) w({ value, done: false });
    else this.buffer.push(value);
  }

  close(): void {
    this.closed = true;
    let w: ((r: IteratorResult<T>) => void) | undefined;
    while ((w = this.waiting.shift())) w({ value: undefined as unknown as T, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

function buildSummary(o: {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signalName: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  outputCapped: boolean;
  capBytes: number;
  spawnError: Error | undefined;
}): string {
  const head = `$ ${[o.command, ...o.args].join(" ")}`;
  const status = o.spawnError
    ? `spawn error: ${o.spawnError.message}`
    : o.outputCapped
      ? `output truncated at ${o.capBytes} bytes (killed)`
      : o.timedOut
        ? `timed out (killed)`
        : o.aborted
          ? `cancelled (killed)`
          : o.signalName
            ? `killed by ${o.signalName}`
            : `exit code ${o.exitCode ?? "unknown"}`;
  const parts = [head, `[${status}]`];
  if (o.stdout) parts.push(`--- stdout ---\n${o.stdout.replace(/\n$/, "")}`);
  if (o.stderr) parts.push(`--- stderr ---\n${o.stderr.replace(/\n$/, "")}`);
  return parts.join("\n");
}

async function* runShellExec(input: ShellInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
  const cwd = input.cwd ? await resolveInWorkspace(ctx.cwd, input.cwd) : ctx.cwd;
  const queue = new AsyncQueue<ToolEvent>();

  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let outputCapped = false;
  let exitCode: number | null = null;
  let signalName: NodeJS.Signals | null = null;
  let timedOut = false;
  let aborted = false;
  let spawnError: Error | undefined;
  let settled = false;

  const baseEnv = scrubSecretEnv(process.env);
  const child = spawn(input.command, input.args, {
    cwd,
    env: input.env ? { ...baseEnv, ...input.env } : baseEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const settle = (): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    queue.close();
  };

  const onAbort = (): void => {
    aborted = true;
    child.kill("SIGKILL");
  };

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, input.timeoutMs);

  ctx.signal.addEventListener("abort", onAbort, { once: true });
  if (ctx.signal.aborted) onAbort();

  const onData = (which: "stdout" | "stderr", d: Buffer): void => {
    if (outputCapped) return;
    const s = d.toString("utf8");
    if (which === "stdout") stdout += s;
    else stderr += s;
    outputBytes += Buffer.byteLength(s, "utf8");
    queue.push({ type: "output", content: [{ type: "text", text: s }] });
    if (outputBytes > input.maxOutputBytes) {
      outputCapped = true;
      child.kill("SIGTERM");
      // Safety net: a process that ignores SIGTERM must not outlive the call.
      const killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 1000);
      killTimer.unref?.();
    }
  };
  child.stdout?.on("data", (d: Buffer) => onData("stdout", d));
  child.stderr?.on("data", (d: Buffer) => onData("stderr", d));
  child.on("error", (err: Error) => {
    spawnError = err;
    settle();
  });
  child.on("close", (code: number | null, sig: NodeJS.Signals | null) => {
    exitCode = code;
    signalName = sig;
    settle();
  });

  try {
    for await (const event of queue) yield event;
  } finally {
    settle();
  }

  const summary = buildSummary({
    command: input.command,
    args: input.args,
    stdout,
    stderr,
    exitCode,
    signalName,
    timedOut,
    aborted,
    outputCapped,
    capBytes: input.maxOutputBytes,
    spawnError,
  });
  const content: ContentBlock[] = [{ type: "text", text: summary }];
  const isError =
    spawnError !== undefined ||
    timedOut ||
    aborted ||
    outputCapped ||
    signalName !== null ||
    (exitCode !== null && exitCode !== 0);
  const result: ToolResult = isError
    ? { ok: false, content, isError: true }
    : { ok: true, content };
  yield { type: "result", result };
}

export const shellExecTool: Tool = {
  name: "shell_exec",
  description:
    "Run a command as an argv array (no shell). Captures stdout/stderr up to a byte cap, enforces a timeout, honors cancellation.",
  permission: "exec",
  timeoutMs: DEFAULT_SHELL_TIMEOUT_MS,
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Executable to run (no shell interpretation)." },
      args: { type: "array", items: { type: "string" }, description: "Argument vector." },
      cwd: { type: "string", description: "Workspace-relative working directory." },
      timeoutMs: { type: "number", description: `Wall-clock timeout (default ${DEFAULT_SHELL_TIMEOUT_MS}).` },
      env: {
        type: "object",
        description: "Extra environment variables (merged over a secret-scrubbed process env).",
      },
      maxOutputBytes: {
        type: "number",
        description: `Combined stdout+stderr byte cap before the process is killed (default ${DEFAULT_MAX_OUTPUT_BYTES}).`,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  run(input: unknown, ctx: ToolContext): AsyncIterable<ToolEvent> {
    return runShellExec(parseShellInput(input), ctx);
  },
};
