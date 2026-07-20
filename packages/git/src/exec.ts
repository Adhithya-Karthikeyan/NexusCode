/**
 * `runGit` — invoke the `git` binary safely via `execFile` (system-spec §14).
 *
 * Safety invariants (mirrors `@nexuscode/tools`' `shell_exec`):
 *   - NEVER a shell. `execFile("git", argv, …)` passes the argument vector
 *     straight to the OS `exec`, so there is no shell to inject into — no
 *     globbing, no `;`, no `$(…)`, no `&&`. Every argument is a literal string.
 *   - The child's environment is scrubbed of anything secret-shaped
 *     (`scrubSecretEnv`) before our own deterministic overrides are merged, so a
 *     git subprocess never inherits loaded provider API keys.
 *   - Non-interactive by construction: `GIT_TERMINAL_PROMPT=0` and
 *     `GIT_OPTIONAL_LOCKS=0` keep git from blocking on a credential prompt or
 *     mutating the index; `LC_ALL=C` pins output to a stable, parseable locale.
 *   - Hard wall-clock timeout and a bounded output buffer; cancellation via
 *     `opts.signal`.
 *
 * A non-zero exit is a *result*, not a thrown error: many git commands signal
 * information through their exit code (`git diff --quiet` returns 1 when there
 * is a diff). Only a genuine spawn failure (git missing, timeout kill) rejects.
 */

import { execFile } from "node:child_process";
import { scrubSecretEnv } from "@nexuscode/tools";

export const DEFAULT_GIT_TIMEOUT_MS = 30_000;

/** 64 MiB — large enough for a sizable diff, bounded so a runaway can't OOM us. */
export const DEFAULT_GIT_MAX_BUFFER = 64 * 1024 * 1024;

export interface GitExecOptions {
  /** Working directory the git command runs in (a repo or worktree path). */
  cwd: string;
  /** Cancellation signal — aborting SIGKILLs the child. */
  signal?: AbortSignal;
  /** Wall-clock timeout in ms. Default {@link DEFAULT_GIT_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Combined stdout+stderr byte cap. Default {@link DEFAULT_GIT_MAX_BUFFER}. */
  maxBuffer?: number;
  /** Extra env merged over the secret-scrubbed base (rarely needed). */
  env?: Record<string, string>;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code; `0` on success. */
  exitCode: number;
  /** `true` iff `exitCode === 0`. */
  ok: boolean;
}

interface ExecFileError extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: NodeJS.Signals | null;
}

/**
 * Build the deterministic, secret-free environment every git call runs under.
 * Secret-shaped names are stripped first; our overrides then pin non-interactive
 * behavior and a stable locale.
 */
function gitEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...scrubSecretEnv(process.env),
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
    ...extra,
  };
}

/**
 * Run `git <args…>` in `opts.cwd`. Arguments are passed as an argv array with no
 * shell interpretation whatsoever. Resolves with captured stdout/stderr and the
 * exit code (including non-zero); rejects only on a spawn/timeout failure.
 */
export function runGit(args: string[], opts: GitExecOptions): Promise<GitExecResult> {
  for (const a of args) {
    if (typeof a !== "string") {
      return Promise.reject(new TypeError("git argument vector must contain only strings"));
    }
  }
  const timeout = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_GIT_MAX_BUFFER;

  return new Promise<GitExecResult>((resolve, reject) => {
    const execOpts: Parameters<typeof execFile>[2] = {
      cwd: opts.cwd,
      env: gitEnv(opts.env),
      timeout,
      maxBuffer,
      encoding: "utf8",
      windowsHide: true,
    };
    if (opts.signal) execOpts.signal = opts.signal;

    execFile("git", args, execOpts, (error, stdout, stderr) => {
      const out = typeof stdout === "string" ? stdout : stdout.toString();
      const err = typeof stderr === "string" ? stderr : stderr.toString();
      if (error) {
        const e = error as ExecFileError;
        // A numeric `code` is git's own exit status — a legitimate result.
        if (typeof e.code === "number") {
          resolve({ stdout: out, stderr: err, exitCode: e.code, ok: e.code === 0 });
          return;
        }
        // ENOENT (git not installed), a timeout kill, or an abort: propagate.
        reject(error);
        return;
      }
      resolve({ stdout: out, stderr: err, exitCode: 0, ok: true });
    });
  });
}

/**
 * Convenience wrapper that throws a descriptive error when git exits non-zero.
 * Use for commands where any non-zero status is genuinely unexpected.
 */
export async function runGitOrThrow(args: string[], opts: GitExecOptions): Promise<string> {
  const r = await runGit(args, opts);
  if (!r.ok) {
    const detail = r.stderr.trim() || r.stdout.trim() || `exit code ${r.exitCode}`;
    throw new Error(`git ${args.join(" ")} failed: ${detail}`);
  }
  return r.stdout;
}
