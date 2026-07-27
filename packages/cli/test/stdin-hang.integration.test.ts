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
 *
 * Second-order regression, also covered here: the first version of
 * `STDIN_FIRST_BYTE_TIMEOUT_MS` (2s) was tight enough to misdiagnose a
 * legitimately slow producer (`curl slow-api | nexus ask`, a script that
 * computes before printing) as an inherited-idle pipe and silently drop its
 * input. Once a prompt argument short-circuits away the common case (above),
 * every remaining `readStdin` caller has stdin as its ONLY input source —
 * nothing to fall back to — so the bound is now a generous 30s by default
 * (`NEXUS_STDIN_TIMEOUT_MS` overrides it; the tests below use a small
 * override to stay fast rather than actually waiting 30s).
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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
 * Spawn the built CLI with stdin an OPEN, non-TTY pipe. Resolves once the
 * process exits on its own, OR is killed after a hard cap DERIVED from
 * `opts.extraEnv.NEXUS_STDIN_TIMEOUT_MS` (the bound this specific run is
 * actually configured with) plus a large fixed safety margin — never a bare
 * literal disconnected from that value. A hardcoded ceiling that has to be
 * hand-edited every time someone tunes the bound is exactly how this test
 * suite produced a false failure once already (raising the shipped default
 * from 2s to 30s broke an earlier version of this file that still hard-capped
 * at 8s): the watchdog and the thing it watches must move together, or not
 * be compared at all. No override ⇒ this run isn't exercising the timeout
 * path (e.g. a short-circuited read that never touches `readStdin`'s timer),
 * so the cap only needs to be "clearly more than instant," not tied to any
 * production constant.
 *
 * `delayed`, when given, writes `delayed.text` to stdin (then closes it)
 * after `delayed.afterMs` — simulating a real producer that is merely SLOW
 * to produce its first byte (`curl slow-api | nexus ask`), as opposed to the
 * default (omitted) behavior of never writing or closing stdin at all, which
 * simulates an inherited-but-silent descriptor with no producer behind it at
 * all. These are deliberately different scenarios with different correct
 * outcomes — see the two describe blocks below.
 */
function spawnWithOpenStdin(
  args: string[],
  opts: { extraEnv?: Record<string, string>; delayed?: { text: string; afterMs: number } } = {},
): Promise<Result> {
  const configuredBoundMs = Number(opts.extraEnv?.["NEXUS_STDIN_TIMEOUT_MS"] ?? 0);
  const hardCapMs = configuredBoundMs + 6_000;
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
        ...opts.extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    liveChild = child;
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", reject);
    // Deliberately: no immediate child.stdin.write(), no immediate .end() —
    // unless `delayed` asks for exactly that, later.
    let delayTimer: NodeJS.Timeout | undefined;
    if (opts.delayed) {
      delayTimer = setTimeout(() => {
        child.stdin.end(opts.delayed!.text);
      }, opts.delayed.afterMs);
    }
    const hardCap = setTimeout(() => {
      child.kill("SIGKILL");
    }, hardCapMs);
    child.on("close", (code, signal) => {
      clearTimeout(hardCap);
      clearTimeout(delayTimer);
      liveChild = undefined;
      resolve({ code, signal, stdout, stderr, elapsedMs: Date.now() - start });
    });
  });
}

describe("stdin hang regression — a prompt argument must never wait on stdin", () => {
  it("`ask` with a prompt argument and an open, never-closing stdin completes promptly (no override — must never even reach the bound)", async () => {
    const r = await spawnWithOpenStdin(["ask", "-p", "mock", "-m", "mock-fast", "hi there"]);
    expect(r.signal).toBeNull(); // null signal ⇒ exited on its own, not SIGKILLed by our hard cap
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("hi there");
    // Comfortably under even the no-override hard cap (6s) — readPrompt must
    // skip the stdin wait entirely when a prompt argument is present, not
    // merely have it bounded (waiting anywhere near that cap would mean it
    // fell through to `readStdin` after all, whatever bound is configured).
    expect(r.elapsedMs).toBeLessThan(1_500);
  }, 10_000);

  it("`agent --role` with a prompt argument and an open stdin also completes promptly (readPrompt is shared)", async () => {
    const r = await spawnWithOpenStdin([
      "agent",
      "--role",
      "coder",
      "--max-steps",
      "1",
      "-p",
      "mock",
      "-m",
      "mock-tools",
      "add hello",
    ]);
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.elapsedMs).toBeLessThan(1_500);
  }, 10_000);
});

describe("stdin hang regression — a genuine stdin read (no positional alternative) is bounded, not silent", () => {
  // Uses NEXUS_STDIN_TIMEOUT_MS to exercise the real 30s-default LOGIC on a
  // short, fast-test-friendly bound instead of actually waiting 30s — the
  // mechanism under test (give up after N ms of total silence, diagnose it)
  // does not care what N is, and the production default is a separate,
  // one-line assertion further down (`readStdin default is 30s`).
  const FAST_BOUND_MS = 400;

  it("`chat` (batch mode, no --persistent) with an open, never-closing stdin gives up within the bound instead of hanging forever", async () => {
    const r = await spawnWithOpenStdin(["chat", "-p", "mock", "-m", "mock-fast"], 8_000, {
      extraEnv: { NEXUS_STDIN_TIMEOUT_MS: String(FAST_BOUND_MS) },
    });
    expect(r.signal).toBeNull(); // must resolve on its own well before the 8s hard cap
    // Nothing was ever piped, so readStdin gives up at the bound and `chat`
    // treats that exactly like `</dev/null`: no lines, exit 0.
    expect(r.code).toBe(0);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(FAST_BOUND_MS - 100);
    expect(r.elapsedMs).toBeLessThan(FAST_BOUND_MS + 4_000);
    // Never silent: the diagnostic explains WHY it waited and gave up.
    expect(r.stderr).toContain("stdin is open but produced no input");
  }, 10_000);

  it("case C — a producer that is silent LONGER than a naive short bound, then emits, must still succeed (the regression this bound-raise fixes)", async () => {
    // Mirrors the exact real-world report: `{ sleep 4; echo "…"; } | nexus ask`
    // failed under the original 2s bound because the first byte legitimately
    // arrived after it. Reproduced here at test speed: the producer writes
    // AFTER the fast bound above would already have given up, but still well
    // within a generous one — proving a slow-but-real producer is not mistaken
    // for an inherited-idle pipe merely for not being instant.
    const r = await spawnWithOpenStdin(["ask", "-p", "mock", "-m", "mock-fast"], 8_000, {
      extraEnv: { NEXUS_STDIN_TIMEOUT_MS: "2000" },
      delayed: { text: "delayed question", afterMs: 700 }, // > FAST_BOUND_MS, < the 2000ms bound here
    });
    expect(r.signal).toBeNull();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("delayed question");
    // Never diagnosed as a timeout — it wasn't one.
    expect(r.stderr).not.toContain("stdin is open but produced no input");
  }, 10_000);
});

describe("stdin hang regression — the shipped default is genuinely generous, not just the test override", () => {
  it("readStdin's default bound (no override) is 30s, not the original 2s that regressed slow pipes", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/commands.ts", import.meta.url)), "utf8");
    const m = src.match(/return Number\.isFinite\(parsed\) && parsed > 0 \? parsed : (\d[\d_]*);/);
    expect(m).not.toBeNull();
    expect(Number(m![1]!.replace(/_/g, ""))).toBe(30_000);
  });
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
