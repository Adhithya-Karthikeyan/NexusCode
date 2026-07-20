/**
 * `runCli` — invoke a container CLI (`docker` / `kubectl` / `oc`) safely via
 * `execFile` (mirrors `@nexuscode/git`'s `runGit` and `@nexuscode/tools`'
 * `shell_exec` invariants).
 *
 * Safety invariants:
 *   - NEVER a shell. `execFile(bin, argv, …)` passes the argument vector straight
 *     to the OS `exec`, so there is no shell to inject into — no globbing, no
 *     `;`, no `$(…)`, no `&&`. Every argument is a literal string.
 *   - The child's environment is scrubbed of anything secret-shaped
 *     (`scrubSecretEnv`) before deterministic overrides are merged, so a docker
 *     or kubectl subprocess never inherits loaded provider API keys.
 *   - Non-interactive + stable locale: `LC_ALL=C` pins parseable output.
 *   - Hard wall-clock timeout and a bounded output buffer; cancellation via
 *     `opts.signal`.
 *   - Feature detection: a missing binary (`ENOENT`) does NOT throw — it
 *     resolves with `notFound: true` so the tool can return a clean
 *     "not installed" ToolResult instead of crashing.
 *
 * A non-zero exit is a *result*, not a thrown error: container CLIs signal
 * information through exit codes (e.g. `docker ps` on a stopped daemon). Only a
 * genuine spawn/timeout/output-cap failure is flagged via the result fields.
 */

import { execFile } from "node:child_process";
import { scrubSecretEnv } from "@nexuscode/tools";

export const DEFAULT_CLI_TIMEOUT_MS = 30_000;

/** 16 MiB — generous for container/pod logs, bounded so a runaway can't OOM us. */
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface CliExecOptions {
  /** Working directory the CLI runs in. */
  cwd: string;
  /** Cancellation signal — aborting SIGKILLs the child. */
  signal?: AbortSignal;
  /** Wall-clock timeout in ms. Default {@link DEFAULT_CLI_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Combined stdout+stderr byte cap. Default {@link DEFAULT_MAX_OUTPUT_BYTES}. */
  maxOutputBytes?: number;
  /** Extra env merged over the secret-scrubbed base (rarely needed). */
  env?: Record<string, string>;
}

export interface CliExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code; `0` on success, `null` when killed by a signal. */
  exitCode: number | null;
  /** `true` iff `exitCode === 0` and nothing failed. */
  ok: boolean;
  /** `true` when the binary is not installed / not on PATH (`ENOENT`). */
  notFound: boolean;
  /** `true` when the wall-clock timeout fired and the child was killed. */
  timedOut: boolean;
  /** `true` when the caller's `signal` aborted the call. */
  aborted: boolean;
  /** `true` when stdout/stderr exceeded the byte cap and output was truncated. */
  outputCapped: boolean;
}

interface ExecFileError extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

/** Deterministic, secret-free environment every container CLI call runs under. */
function cliEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...scrubSecretEnv(process.env),
    LC_ALL: "C",
    ...extra,
  };
}

/**
 * Run `<bin> <args…>` in `opts.cwd`. Arguments are passed as an argv array with
 * no shell interpretation whatsoever. Resolves (never rejects) with captured
 * output and structured status flags — a missing binary, a non-zero exit, a
 * timeout, an abort, and an output-cap breach are all reported as fields.
 */
export function runCli(bin: string, args: string[], opts: CliExecOptions): Promise<CliExecResult> {
  for (const a of args) {
    if (typeof a !== "string") {
      return Promise.reject(new TypeError("CLI argument vector must contain only strings"));
    }
  }
  const timeout = opts.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS;
  const maxBuffer = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  return new Promise<CliExecResult>((resolve) => {
    const execOpts: Parameters<typeof execFile>[2] = {
      cwd: opts.cwd,
      env: cliEnv(opts.env),
      timeout,
      maxBuffer,
      encoding: "utf8",
      windowsHide: true,
    };
    if (opts.signal) execOpts.signal = opts.signal;

    execFile(bin, args, execOpts, (error, stdout, stderr) => {
      const out = typeof stdout === "string" ? stdout : stdout.toString();
      const err = typeof stderr === "string" ? stderr : stderr.toString();
      const base = {
        stdout: out,
        stderr: err,
        notFound: false,
        timedOut: false,
        aborted: false,
        outputCapped: false,
      };
      if (error) {
        const e = error as ExecFileError;
        // A numeric `code` is the CLI's own exit status — a legitimate result.
        if (typeof e.code === "number") {
          resolve({ ...base, exitCode: e.code, ok: e.code === 0 });
          return;
        }
        if (e.code === "ENOENT") {
          resolve({ ...base, exitCode: null, ok: false, notFound: true });
          return;
        }
        if (e.code === "ERR_CHILD_PROCESS_STDOUT_MAXBUFFER" || e.code === "ERR_CHILD_PROCESS_MAXBUFFER") {
          resolve({ ...base, exitCode: null, ok: false, outputCapped: true });
          return;
        }
        // A caller-driven cancellation surfaces as an AbortError (`ABORT_ERR`),
        // or — if it raced with the kill — as a `killed` child whose signal is
        // already aborted.
        if (e.code === "ABORT_ERR" || e.name === "AbortError" || opts.signal?.aborted === true) {
          resolve({ ...base, exitCode: null, ok: false, aborted: true });
          return;
        }
        // A timeout kill surfaces as `killed` with a terminating signal.
        if (e.killed) {
          resolve({ ...base, exitCode: null, ok: false, timedOut: true });
          return;
        }
        // Unknown spawn failure — report as a non-ok result, never throw.
        resolve({ ...base, stderr: err || e.message, exitCode: null, ok: false });
        return;
      }
      resolve({ ...base, exitCode: 0, ok: true });
    });
  });
}
