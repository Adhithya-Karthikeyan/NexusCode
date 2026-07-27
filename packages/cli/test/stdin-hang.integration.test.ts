/**
 * Regression for a real reported hang: `nexus ask -p mock -m mock-fast "hi"`
 * ran fine with `</dev/null` but hung indefinitely — zero bytes on stdout AND
 * stderr — when stdin was an open, non-TTY pipe that never delivered data or
 * closed (exactly what a process spawned by another process without an
 * explicit stdin redirect inherits). `readPrompt` (`commands.ts`) awaited
 * `readStdin()` UNCONDITIONALLY, even with a prompt argument already in
 * hand, and `readStdin()` itself had no bound on the wait.
 *
 * The shared `spawnCli` test helper (`helpers/spawn-cli.ts`) always calls
 * `child.stdin.end(...)`, which closes stdin immediately — that is exactly
 * why every existing test suite passed while the real bug was live: the
 * harness itself could never reproduce an open, un-ended stdin. This file
 * spawns directly and deliberately leaves `child.stdin` open and untouched.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-stdinhang-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-stdinhang-data-")), "data");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-stdinhang-cwd-"));

if (!existsSync(BIN)) {
  throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before this test`);
}

interface Result {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

let liveChild: ChildProcessWithoutNullStreams | undefined;

afterEach(() => {
  // Belt-and-suspenders: if an assertion throws before a test's own cleanup
  // runs, don't leak a real hung child process into the rest of the suite.
  liveChild?.kill("SIGKILL");
  liveChild = undefined;
});

/**
 * Spawn the built CLI with stdin an OPEN, non-TTY pipe that is never written
 * to and never closed — the exact shape of an inherited-but-silent stdin.
 * Resolves once the process exits on its own, OR is killed after `hardCapMs`
 * (a real bug reproduction, not a false pass: if the fix regresses, this
 * test fails with a clear timeout instead of hanging the whole suite).
 */
function spawnWithOpenStdin(args: string[], hardCapMs: number): Promise<Result> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: CONFIG_DIR,
        NEXUS_DATA_DIR: DATA_DIR,
        NEXUSCODE_DATA_DIR: DATA_DIR,
        NEXUS_HISTORY_DISABLED: "1",
        NEXUS_VAULT_PASSPHRASE: "test-passphrase",
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
    const hardCap = setTimeout(() => {
      child.kill("SIGKILL");
    }, hardCapMs);
    child.on("close", (code, signal) => {
      clearTimeout(hardCap);
      liveChild = undefined;
      resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - start });
    });
  });
}

describe("stdin hang regression — a prompt argument must never wait on stdin", () => {
  it("`ask` with a prompt argument and an open, never-closing stdin completes promptly (not the 2s stdin bound, not a hang)", async () => {
    const r = await spawnWithOpenStdin(["ask", "-p", "mock", "-m", "mock-fast", "hi there"], 8_000);
    expect(r.signal).toBeNull(); // null signal ⇒ exited on its own, not SIGKILLed by our hard cap
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hi there");
    // Comfortably under STDIN_FIRST_BYTE_TIMEOUT_MS (2000ms) — readPrompt must
    // skip the stdin wait entirely when a prompt argument is present, not
    // merely have it bounded.
    expect(r.elapsedMs).toBeLessThan(1_500);
  }, 10_000);

  it("`agent --role` with a prompt argument and an open stdin also completes promptly (readPrompt is shared)", async () => {
    const r = await spawnWithOpenStdin(
      ["agent", "--role", "coder", "--max-steps", "1", "-p", "mock", "-m", "mock-tools", "add hello"],
      8_000,
    );
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.elapsedMs).toBeLessThan(1_500);
  }, 10_000);
});

describe("stdin hang regression — a genuine stdin read (no positional alternative) is bounded, not silent", () => {
  it("`chat` (batch mode, no --persistent) with an open, never-closing stdin gives up within the bound instead of hanging forever", async () => {
    const r = await spawnWithOpenStdin(["chat", "-p", "mock", "-m", "mock-fast"], 8_000);
    expect(r.signal).toBeNull(); // must resolve on its own well before the 8s hard cap
    // Nothing was ever piped, so readStdin gives up at STDIN_FIRST_BYTE_TIMEOUT_MS
    // (2000ms) and `chat` treats that exactly like `</dev/null`: no lines, exit 0.
    expect(r.code).toBe(0);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(1_900);
    expect(r.elapsedMs).toBeLessThan(6_000);
    // Never silent: the diagnostic explains WHY it waited and gave up.
    expect(r.stderr).toContain("stdin is open but produced no input");
  }, 10_000);
});

describe("stdin hang regression — piping still works exactly as documented", () => {
  it("`ask` with NO prompt argument still reads the full piped prompt (short-circuit didn't break real piping)", async () => {
    const child = spawn(process.execPath, [BIN, "ask", "-p", "mock", "-m", "mock-fast"], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: CONFIG_DIR,
        NEXUS_DATA_DIR: DATA_DIR,
        NEXUSCODE_DATA_DIR: DATA_DIR,
        NEXUS_HISTORY_DISABLED: "1",
        NEXUS_VAULT_PASSPHRASE: "test-passphrase",
      },
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stdin.end("piped question from a real, closing pipe");
    const code: number = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? -1)));
    expect(code).toBe(0);
    expect(stdout).toContain("piped question from a real, closing pipe");
  }, 10_000);

  it("`ask` with a prompt argument ignores stdin even when data is genuinely ready — the documented contract, not a partial short-circuit", async () => {
    // `ask --help` / docs/COMMANDS.md: "Reads stdin when no prompt is given."
    // Not "…or concatenates it when one is." Before this fix, `readPrompt`
    // always awaited stdin regardless — the bug this whole file regresses —
    // and happened to concatenate a positional with piped input as a side
    // effect of never skipping the read. That behavior was never documented
    // and had no test asserting it; restoring the documented contract exactly
    // means this now goes the other way. Piping REAL, already-buffered data
    // (not an open silent pipe) isolates that this is a deliberate contract
    // choice, not just "we happened to time out before it arrived."
    const child = spawn(process.execPath, [BIN, "ask", "-p", "mock", "-m", "mock-fast", "the real prompt"], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: CONFIG_DIR,
        NEXUS_DATA_DIR: DATA_DIR,
        NEXUSCODE_DATA_DIR: DATA_DIR,
        NEXUS_HISTORY_DISABLED: "1",
        NEXUS_VAULT_PASSPHRASE: "test-passphrase",
      },
    });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stdin.end("this piped text must be ignored, not concatenated");
    const code: number = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? -1)));
    expect(code).toBe(0);
    expect(stdout).toContain("the real prompt");
    expect(stdout).not.toContain("must be ignored");
  }, 10_000);
});
