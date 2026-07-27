/**
 * Shared low-level process spawner for the CLI integration suites.
 *
 * Every `*.integration.test.ts` file spawns the REAL built `nexus` binary
 * (`dist/index.js`) as a child process. This repo is a large npm workspace
 * where many packages' `dist/` output is produced by `tsup`, whose "clean
 * output folder" step deletes and rewrites each package's compiled files
 * non-atomically. If a `nexus` child process starts while some workspace
 * package it imports (e.g. `@nexuscode/session`, `@nexuscode/config`) is
 * mid-rewrite by a concurrent build, Node's ESM loader can transiently fail
 * to resolve or parse it — even though the source is correct and a rebuilt
 * `dist/` a few milliseconds later is fine. Under CPU load (many test files
 * spawning children in parallel, or another build running alongside the
 * suite) this window widens and becomes reproducible.
 *
 * This is a real, self-healing race in process *startup*, not a bug in the
 * CLI logic under test — a genuine CLI bug reproduces every time, this does
 * not. So `spawnCli` recognizes the specific Node ESM error signatures for
 * this race and re-spawns (never re-asserts) a bounded number of times with
 * a short backoff. Every other failure — including a CLI that starts fine
 * but exits non-zero, or prints something the test doesn't expect — is
 * returned as-is on the first attempt for the test to assert on normally.
 */
import { spawn } from "node:child_process";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnCliOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
}

// Signatures Node's ESM loader produces when a workspace package's `dist/`
// is caught mid-rewrite (deleted, truncated, or partially written by a
// concurrent build) — never something the `nexus` CLI itself would print.
const TRANSIENT_BUILD_RACE_PATTERNS: RegExp[] = [
  /ERR_MODULE_NOT_FOUND/,
  /does not provide an export named/,
  /Unexpected end of input/,
  /Unexpected token ['"]export['"]/,
  /Cannot find module '.*\/dist\//,
];

function isTransientBuildRace(result: CliResult): boolean {
  // A real CLI failure prints through our own error handling and virtually
  // always still writes *something* useful to stdout/stderr in our format.
  // The build race is a hard crash before the CLI ever runs: empty stdout
  // plus a raw Node loader stack trace.
  if (result.stdout !== "") return false;
  return TRANSIENT_BUILD_RACE_PATTERNS.some((p) => p.test(result.stderr));
}

function spawnOnce(bin: string, args: string[], opts: SpawnCliOptions): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: opts.cwd,
      env: opts.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

const RETRY_DELAYS_MS = [150, 400, 900];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Spawn the built `nexus` binary, transparently absorbing the dist-rewrite race described above. */
export async function spawnCli(bin: string, args: string[], opts: SpawnCliOptions): Promise<CliResult> {
  let last: CliResult = { code: -1, stdout: "", stderr: "" };
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    last = await spawnOnce(bin, args, opts);
    if (!isTransientBuildRace(last)) return last;
    if (attempt < RETRY_DELAYS_MS.length) {
      await delay(RETRY_DELAYS_MS[attempt]!);
    }
  }
  return last;
}
