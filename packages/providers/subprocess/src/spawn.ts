/**
 * Minimal, injectable subprocess abstraction.
 *
 * The subprocess adapters spawn a coding CLI and stream its stdout. Rather than
 * hard-depend on `execa`, the base is written against this tiny {@link SpawnFn}
 * seam so tests can point the adapter at a deterministic fake CLI (via a real
 * `defaultSpawn` over a node fixture script) *or* inject a fully synthetic spawn
 * function. The default implementation uses `node:child_process` — no runtime
 * dependency, fully offline. An `execa`-backed `SpawnFn` can be dropped in
 * without touching the base (the shapes are intentionally compatible).
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { Readable } from "node:stream";

export interface SpawnOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
}

/** Terminal disposition of a spawned child. `error` is set for spawn failures
 * (e.g. `ENOENT` when the binary is not on `PATH`) instead of throwing. */
export interface SpawnExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

/**
 * The subset of a child process the base needs. Deliberately compatible with
 * both `node:child_process` and `execa` children.
 */
export interface SpawnedChild {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  /** True once a kill signal has been delivered. */
  readonly killed: boolean;
  /** The exit code once exited, else `null`. */
  readonly exitCode: number | null;
  /** Send a signal; returns whether it was delivered. Never throws. */
  kill(signal?: NodeJS.Signals | number): boolean;
  /** Resolves (never rejects) once the process has exited or failed to spawn. */
  readonly done: Promise<SpawnExit>;
}

export type SpawnFn = (
  bin: string,
  args: readonly string[],
  opts: SpawnOptions,
) => SpawnedChild;

/**
 * Default {@link SpawnFn} over `node:child_process`. stdin is ignored, stdout
 * and stderr are piped. Spawn failures surface via `done` (resolved with an
 * `error`), never as a synchronous throw or an unhandled rejection.
 */
export const defaultSpawn: SpawnFn = (bin, args, opts) => {
  const child = nodeSpawn(bin, args as string[], {
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const done = new Promise<SpawnExit>((resolve) => {
    let settled = false;
    const finish = (exit: SpawnExit): void => {
      if (settled) return;
      settled = true;
      resolve(exit);
    };
    child.once("error", (error: Error) => finish({ exitCode: null, signal: null, error }));
    child.once("close", (code, signal) => finish({ exitCode: code, signal }));
  });

  return {
    get stdout() {
      return child.stdout;
    },
    get stderr() {
      return child.stderr;
    },
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    kill: (signal?: NodeJS.Signals | number) => {
      try {
        return child.kill(signal as NodeJS.Signals);
      } catch {
        return false;
      }
    },
    done,
  };
};
