/**
 * `nexus commit`/`review`/`explain`/`pr` — regression for a SECOND copy of the
 * exact stdin hang `stdin-hang.integration.test.ts` already regresses.
 *
 * `wave6.ts` (`resolveDiff`, `cmdCommit`, `cmdPr`) had its own byte-for-byte
 * copy of the PRE-FIX `readStdin()` — unbounded, no diagnostic, no
 * `pause()`/`unref()` release — so fixing `commands.ts` alone left
 * `git diff | nexus review`, `nexus commit`, `nexus explain`, and `nexus pr`
 * still exposed to an inherited, non-TTY, never-closing stdin blocking
 * forever with zero output on both streams. `wave6.ts` now imports the SAME
 * bounded `readStdin` from `commands.ts` — this file proves that end to end,
 * the same way `stdin-hang.integration.test.ts` proves the `commands.ts` side:
 * with stdin genuinely inherited (a real open FIFO), never through a harness
 * that closes it (which is exactly how the duplicate itself went unnoticed).
 */

import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-gfstdin-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-gfstdin-data-")), "data");
const REPO_DIR = mkdtempSync(join(tmpdir(), "nx-gfstdin-repo-"));

function git(args: string[]): void {
  execFileSync("git", args, { cwd: REPO_DIR, stdio: "pipe" });
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before this test`);
  }
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.dev"]);
  git(["config", "user.name", "T"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(REPO_DIR, "app.ts"), "export const a = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  // An unstaged change every flow below can diff against.
  writeFileSync(join(REPO_DIR, "app.ts"), "export const a = 2;\n");
});

interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

let liveChild: ChildProcessWithoutNullStreams | undefined;

afterEach(() => {
  // Belt-and-suspenders: don't leak a real hung child into the rest of the
  // suite if an assertion throws before this test's own cleanup runs.
  liveChild?.kill("SIGKILL");
  liveChild = undefined;
});

/**
 * Spawn the built CLI, in the real git repo, with stdin an OPEN, non-TTY
 * pipe — the exact shape of an inherited-but-silent descriptor, never
 * written to or closed. The watchdog is derived from `NEXUS_STDIN_TIMEOUT_MS`
 * (the bound THIS run is actually configured with) plus a fixed margin —
 * see `stdin-hang.integration.test.ts` for why a bare literal here would be
 * how this exact test suite produces a false failure the next time the bound
 * is tuned.
 */
function spawnWithOpenStdin(args: string[], stdinTimeoutMs: number): Promise<Result> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: REPO_DIR,
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: CONFIG_DIR,
        NEXUS_DATA_DIR: DATA_DIR,
        NEXUS_HISTORY_DISABLED: "1",
        NEXUS_STDIN_TIMEOUT_MS: String(stdinTimeoutMs),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    liveChild = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    // Deliberately: no child.stdin.write(), no child.stdin.end().
    const hardCap = setTimeout(() => child.kill("SIGKILL"), stdinTimeoutMs + 6_000);
    child.on("close", (code, signal) => {
      clearTimeout(hardCap);
      liveChild = undefined;
      resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - start });
    });
  });
}

const FAST_BOUND_MS = 400;

describe("git flow commands — an inherited, open, never-closing stdin must not hang forever", () => {
  it("`nexus commit` gives up on stdin within the bound and falls through to the real repo diff", async () => {
    const r = await spawnWithOpenStdin(["commit", "-p", "mock", "-m", "mock-fast"], FAST_BOUND_MS);
    expect(r.signal).toBeNull(); // resolved on its own, not SIGKILLed by the watchdog
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("stdin is open but produced no input");
    // Fell through to the actual repo diff (app.ts), not an empty commit.
    expect(r.stdout).toContain("app.ts");
  }, 15_000);

  it("`nexus explain` gives up on stdin within the bound and falls through to the real repo diff", async () => {
    const r = await spawnWithOpenStdin(["explain", "-p", "mock", "-m", "mock-fast"], FAST_BOUND_MS);
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("stdin is open but produced no input");
    expect(r.stdout).toContain("app.ts");
  }, 15_000);

  it("`nexus review` (piped-diff-only path, via resolveDiff) gives up on stdin within the bound and falls through to the real repo diff", async () => {
    const r = await spawnWithOpenStdin(["review", "-p", "mock", "-m", "mock-fast"], FAST_BOUND_MS);
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("stdin is open but produced no input");
  }, 15_000);

  it("`nexus pr` gives up on stdin within the bound and falls through to history-based generation", async () => {
    const r = await spawnWithOpenStdin(["pr", "-p", "mock", "-m", "mock-fast"], FAST_BOUND_MS);
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("stdin is open but produced no input");
  }, 15_000);

  it("a REAL but delayed piped diff (slower than a naive short bound) is still picked up, not mistaken for an inherited-idle pipe", async () => {
    // Mirrors stdin-hang.integration.test.ts's "case C": the producer writes
    // AFTER the fast bound above would already have given up, but within a
    // more generous one — proving `resolveDiff`'s stdin path isn't cut short
    // merely for not being instant, same guarantee as the `ask`/`chat` path.
    const boundMs = 2_000;
    const start = Date.now();
    const child = spawn(process.execPath, [BIN, "explain", "-p", "mock", "-m", "mock-fast"], {
      cwd: REPO_DIR,
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: CONFIG_DIR,
        NEXUS_DATA_DIR: DATA_DIR,
        NEXUS_HISTORY_DISABLED: "1",
        NEXUS_STDIN_TIMEOUT_MS: String(boundMs),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    liveChild = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    setTimeout(() => {
      child.stdin.end("diff --git a/fixture.txt b/fixture.txt\n+delayed real diff content\n");
    }, 700); // > FAST_BOUND_MS, < boundMs
    const code: number = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (c) => {
        liveChild = undefined;
        resolve(c ?? -1);
      });
    });
    expect(Date.now() - start).toBeLessThan(boundMs + 4_000);
    expect(code).toBe(0);
    expect(stderr).not.toContain("stdin is open but produced no input");
    expect(stdout).toContain("delayed real diff content");
  }, 15_000);
});
