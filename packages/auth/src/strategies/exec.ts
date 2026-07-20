/**
 * A tiny, fully-injectable environment seam for the `cli-delegate` and
 * `cloud-sso` strategies: is a binary on PATH, does a session file exist, run a
 * subcommand, and where is HOME. The default implementation is real
 * (`node:child_process` + `node:fs`); tests inject a fake so vendor-CLI login
 * detection and invocation are verified OFFLINE against fixtures — no real
 * `claude`/`codex`/`aws`/`gcloud` binary is ever required.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { homedir } from "node:os";

/** The result of running a delegated login/status command. */
export interface CommandResult {
  /** Process exit code, or null if the child was signalled. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Set when the binary could not be spawned at all (e.g. ENOENT). */
  spawnError?: string;
}

/** Options for a delegated command run. */
export interface RunOptions {
  /** Wall-clock timeout in ms (default 120_000). */
  timeoutMs?: number;
  /** Extra env merged over the current process env. */
  env?: NodeJS.ProcessEnv;
  /** Inherit stdio so an interactive vendor login can talk to the user's TTY. */
  interactive?: boolean;
  signal?: AbortSignal;
}

/** The injectable environment surface both delegate strategies depend on. */
export interface StrategyExec {
  /** True when `bin` resolves on PATH (or is an existing path). */
  which(bin: string): boolean;
  /** True when the file at `path` exists (session/credential file detection). */
  fileExists(path: string): boolean;
  /** The user's home directory (session files live under it). */
  home(): string;
  /** Run `bin args` and resolve with the captured result (never throws). */
  run(bin: string, args: string[], opts?: RunOptions): Promise<CommandResult>;
}

/** Resolve `bin` against PATH (or as a direct path). Offline, synchronous. */
export function binaryOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  if (bin.includes("/") || bin.includes("\\")) {
    return exts.some((e) => existsSync(bin + e));
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const e of exts) {
      if (existsSync(join(dir, bin + e))) return true;
    }
  }
  return false;
}

/** The real {@link StrategyExec}, backed by `node:child_process` + `node:fs`. */
export function defaultExec(): StrategyExec {
  return {
    which: (bin) => binaryOnPath(bin),
    fileExists: (path) => existsSync(path),
    home: () => process.env.HOME ?? process.env.USERPROFILE ?? homedir(),
    run: (bin, args, opts = {}) =>
      new Promise<CommandResult>((resolve) => {
        const timeoutMs = opts.timeoutMs ?? 120_000;
        let child;
        try {
          child = spawn(bin, args, {
            stdio: opts.interactive ? "inherit" : ["ignore", "pipe", "pipe"],
            env: opts.env ? { ...process.env, ...opts.env } : process.env,
            ...(opts.signal ? { signal: opts.signal } : {}),
          });
        } catch (e) {
          resolve({ code: null, stdout: "", stderr: "", spawnError: String((e as Error)?.message ?? e) });
          return;
        }
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (d: unknown) => {
          stdout += String(d);
        });
        child.stderr?.on("data", (d: unknown) => {
          stderr += String(d);
        });
        let settled = false;
        const done = (r: CommandResult): void => {
          if (settled) return;
          settled = true;
          resolve(r);
        };
        const timer = setTimeout(() => {
          try {
            child.kill("SIGTERM");
          } catch {
            /* already gone */
          }
          done({ code: null, stdout, stderr, spawnError: `timed out after ${timeoutMs}ms` });
        }, timeoutMs);
        timer.unref?.();
        child.once("error", (e) => {
          clearTimeout(timer);
          done({ code: null, stdout, stderr, spawnError: String(e?.message ?? e) });
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          done({ code, stdout, stderr });
        });
      }),
  };
}
