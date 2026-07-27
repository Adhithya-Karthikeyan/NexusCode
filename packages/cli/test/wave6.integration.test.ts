/**
 * Wave 6 CLI wiring, end-to-end over the built binary — fully offline (mock
 * provider, temp data dir, temp git repo). Proves the four deliverables are
 * genuinely wired:
 *
 *   A) OBSERVABILITY — an instrumented mock run writes spans; `nexus trace`
 *      renders them back (a `run` span exists).
 *   B) SESSIONS      — a recorded mock run shows up in `nexus session list`,
 *      and `nexus replay` re-renders its timeline.
 *   C) CODE RECEIPT  — `nexus receipt` writes a LOCAL html file that REDACTS a
 *      secret in the prompt (no upload; path printed).
 *   D) GIT           — `git diff | nexus review` runs against the mock; `commit`
 *      / `explain` operate on a real temp git repo's diff.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { spawnCli } from "./helpers/spawn-cli.js";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-w6-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-w6-data-")), "data");
const HISTORY_DB = join(DATA_DIR, "history.db");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-w6-cwd-"));
const REPO_DIR = mkdtempSync(join(tmpdir(), "nx-w6-repo-"));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  input = "",
  cwd = WORK_DIR,
  extraEnv: Record<string, string> = {},
): Promise<CliResult> {
  return spawnCli(BIN, args, {
    cwd,
    input,
    env: {
      ...process.env,
      NEXUS_CONFIG_DIR: CONFIG_DIR,
      NEXUS_DATA_DIR: DATA_DIR,
      // History ENABLED at a temp db (traces.ndjson lands beside it).
      NEXUS_HISTORY_DB: HISTORY_DB,
      NEXUS_VAULT_PASSPHRASE: "test-passphrase",
      ...extraEnv,
    },
  });
}

function git(args: string[]): void {
  execFileSync("git", args, { cwd: REPO_DIR, stdio: "pipe" });
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` first`);
  }
  // A real, self-contained temp git repo for the git-flow tests.
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.dev"]);
  git(["config", "user.name", "T"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(REPO_DIR, "app.ts"), "export const a = 1;\n");
  git(["add", "."]);
  git(["commit", "-q", "-m", "init"]);
  // An unstaged change for the diff-driven flows.
  writeFileSync(join(REPO_DIR, "app.ts"), "export const a = 2;\nexport const b = 3;\n");
});

/** Run a mock turn (records event_log + run_summary + writes trace spans). */
async function seedMockRun(prompt = "hello wave six"): Promise<void> {
  const r = await runCli(["ask", "-p", "mock", prompt]);
  expect(r.code).toBe(0);
}

async function firstSessionId(): Promise<string> {
  const r = await runCli(["session", "list", "-o", "json"]);
  expect(r.code).toBe(0);
  const sessions = JSON.parse(r.stdout.trim()) as { sessionId: string }[];
  expect(sessions.length).toBeGreaterThan(0);
  return sessions[0]!.sessionId;
}

describe("wave 6 — sessions", () => {
  it("session list shows a session recorded from a mock run", async () => {
    await seedMockRun("a recorded turn");
    const r = await runCli(["session", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mock");
    // JSON form: at least one session with run + token accounting.
    const j = await runCli(["session", "list", "-o", "json"]);
    const sessions = JSON.parse(j.stdout.trim()) as {
      sessionId: string;
      provider?: string;
      runCount: number;
    }[];
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions[0]!.provider).toBe("mock");
    expect(sessions[0]!.runCount).toBeGreaterThan(0);
  }, 20_000);

  it("session show + rename + replay round-trip a recorded session", async () => {
    const id = await firstSessionId();

    const rename = await runCli(["session", "rename", id, "my-feature"]);
    expect(rename.code).toBe(0);

    const show = await runCli(["session", "show", id]);
    expect(show.code).toBe(0);
    expect(show.stdout).toContain("my-feature");

    // Replay re-renders the timeline; ndjson form feeds a downstream TUI.
    const replay = await runCli(["replay", id, "-o", "ndjson"]);
    expect(replay.code).toBe(0);
    const events = replay.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { t: string });
    expect(events.map((e) => e.t)).toContain("session");
    expect(events.some((e) => e.t === "text")).toBe(true);
  }, 20_000);

  it("replay reproduces a role run's OODA `agent`/`reasoning` narrative, `data` and pairing intact", async () => {
    const live = await runCli([
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
      "-o",
      "ndjson",
    ]);
    expect(live.code).toBe(0);
    const liveEvents = live.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { t: string; [k: string]: unknown });
    const liveAgentEvents = liveEvents.filter((e) => e.t === "agent");
    expect(liveAgentEvents.length).toBeGreaterThan(0);
    const sessionEvent = liveEvents.find((e) => e.t === "session") as { sessionId: string } | undefined;
    expect(sessionEvent?.sessionId).toBeTruthy();

    const replay = await runCli(["replay", sessionEvent!.sessionId, "-o", "ndjson"]);
    expect(replay.code).toBe(0);
    const replayEvents = replay.stdout
      .trim()
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { t: string; [k: string]: unknown });

    // Every agent event seen live is reproduced, in order, `data` intact.
    const replayAgentEvents = replayEvents.filter((e) => e.t === "agent");
    expect(replayAgentEvents).toEqual(liveAgentEvents);

    // The pairing the Swift/TUI fold relies on: an `agent` event is
    // immediately followed by the `reasoning` event carrying the same text.
    for (let i = 0; i < replayEvents.length; i++) {
      const ev = replayEvents[i]!;
      if (ev.t !== "agent") continue;
      const next = replayEvents[i + 1];
      expect(next?.t).toBe("reasoning");
      expect(next?.["delta"]).toBe(ev["text"]);
    }

    // The final `stop` event's verdict — the whole point of a role run's
    // "was this actually verified?" narrative — survives the round trip.
    const stopEvent = replayAgentEvents.find((e) => e["phase"] === "stop");
    expect(stopEvent).toBeDefined();
    expect(stopEvent!["data"]).toMatchObject({
      stopReason: expect.any(String),
      verdict: expect.stringMatching(/^(met|unmet|indeterminate)$/),
    });
  }, 20_000);

  it("session rename/branch/delete mutations emit valid JSON", async () => {
    const id = await firstSessionId();
    const rename = await runCli([
      "session",
      "rename",
      id,
      "json-session",
      "-o",
      "json",
    ]);
    expect(rename.code).toBe(0);
    expect(JSON.parse(rename.stdout.trim())).toEqual({
      sessionId: id,
      name: "json-session",
    });

    const branch = await runCli([
      "session",
      "branch",
      id,
      "--name",
      "json-branch",
      "-o",
      "json",
    ]);
    expect(branch.code).toBe(0);
    const branched = JSON.parse(branch.stdout.trim()) as {
      sessionId: string;
      parentSessionId: string;
      name: string;
    };
    expect(branched).toMatchObject({
      parentSessionId: id,
      name: "json-branch",
    });

    const remove = await runCli([
      "session",
      "delete",
      branched.sessionId,
      "-o",
      "json",
    ]);
    expect(remove.code).toBe(0);
    expect(JSON.parse(remove.stdout.trim())).toEqual({
      sessionId: branched.sessionId,
      deleted: true,
    });
  }, 20_000);
});

describe("wave 6 — history JSON contract", () => {
  it("uses public camelCase fields and accepts the listed runId in history show", async () => {
    await seedMockRun("history json contract");
    const list = await runCli(["history", "list", "-o", "json"]);
    expect(list.code).toBe(0);
    const runs = JSON.parse(list.stdout.trim()) as Array<{
      runId: string;
      sessionId: string;
      provider: string;
      createdAt: number;
      run_id?: string;
    }>;
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]).toMatchObject({
      runId: expect.any(String),
      sessionId: expect.any(String),
      provider: "mock",
      createdAt: expect.any(Number),
    });
    expect(runs[0]!.run_id).toBeUndefined();

    const show = await runCli(["history", "show", runs[0]!.runId, "-o", "json"]);
    expect(show.code).toBe(0);
    const events = JSON.parse(show.stdout.trim()) as Array<{
      runId: string;
      sessionId: string;
      payload: unknown;
      run_id?: string;
    }>;
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toMatchObject({
      runId: runs[0]!.runId,
      sessionId: runs[0]!.sessionId,
      payload: expect.any(Object),
    });
    expect(events[0]!.run_id).toBeUndefined();
  }, 20_000);
});

describe("wave 6 — code receipt (private, local, redaction-safe)", () => {
  it("receipt writes a LOCAL html file and redacts a secret in the prompt", async () => {
    const id = await firstSessionId();
    const out = join(WORK_DIR, "receipt.html");
    const secret = "sk-live0123456789ABCDEFghij0123456789";
    const r = await runCli([
      "receipt",
      id,
      "-o",
      out,
      "--prompt",
      `deploy with key ${secret}`,
    ]);
    expect(r.code).toBe(0);
    // Prints ONLY the local path (private by default — no upload).
    expect(r.stdout.trim()).toBe(out);
    expect(r.stdout).not.toMatch(/https?:\/\//);
    expect(existsSync(out)).toBe(true);

    const html = readFileSync(out, "utf8");
    expect(html).toContain("Code Receipt");
    // The secret is redacted, never emitted verbatim.
    expect(html).not.toContain(secret);
    expect(html).toContain("[REDACTED]");
  }, 20_000);
});

describe("wave 6 — observability (trace)", () => {
  it("trace renders spans (incl. a run span) for a recorded mock run", async () => {
    await seedMockRun("trace me please");
    const json = await runCli(["trace", "-o", "json"]);
    expect(json.code).toBe(0);
    const spans = JSON.parse(json.stdout.trim()) as {
      name: string;
      kind: string;
      traceId: string;
    }[];
    expect(spans.length).toBeGreaterThan(0);
    expect(spans.some((s) => s.kind === "run")).toBe(true);

    // Text form renders a Gantt-style timeline.
    const text = await runCli(["trace"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/trace .* span/);
    expect(text.stdout).toContain("[run]");
  }, 20_000);

  it("an empty trace filter behaves exactly like a bogus one (never dumps every span)", async () => {
    await seedMockRun("trace empty-arg regression");
    const bogus = await runCli(["trace", "zzz-not-real"]);
    expect(bogus.code).toBe(1);
    expect(bogus.stderr).toContain('no spans for "zzz-not-real"');

    const empty = await runCli(["trace", ""]);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain('no spans for ""');
    // Must NOT succeed with the full unfiltered dump.
    expect(empty.stdout).toBe("");
  }, 20_000);

  it("doctor reports the observability subsystem with a span count", async () => {
    const r = await runCli(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("observ");
    expect(r.stdout).toMatch(/exporter=file/);
  }, 20_000);
});

describe("wave 6 — git flows (against the mock provider)", () => {
  it("git diff | nexus review runs against the mock and returns comments", async () => {
    const diff = execFileSync("git", ["diff"], { cwd: REPO_DIR }).toString();
    expect(diff).toContain("app.ts");
    const r = await runCli(["review", "-p", "mock", "-m", "mock-fast"], diff);
    expect(r.code).toBe(0);
    // The echo mock reflects the (redacted) review prompt back as a comment.
    expect(r.stdout).toContain("git diff");
  }, 20_000);

  it("nexus review reads the working tree of a real git repo", async () => {
    const r = await runCli(["review", "-p", "mock", "-m", "mock-fast"], "", REPO_DIR);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  }, 20_000);

  it("nexus explain summarizes a piped diff via the mock", async () => {
    const diff = execFileSync("git", ["diff"], { cwd: REPO_DIR }).toString();
    const r = await runCli(["explain", "-p", "mock", "-m", "mock-fast"], diff);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Explain the following git diff");
  }, 20_000);

  it("nexus commit generates a Conventional Commit message from the staged diff", async () => {
    git(["add", "."]);
    const r = await runCli(["commit", "-p", "mock", "-m", "mock-fast"], "", REPO_DIR);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  }, 20_000);

  it("nexus pr generates a description from the repo history + diff", async () => {
    // A second commit so `--base HEAD~1` spans a real range.
    git(["add", "."]);
    git(["commit", "-q", "-m", "feat: add b"]);
    const r = await runCli(["pr", "-p", "mock", "-m", "mock-fast", "--base", "HEAD~1"], "", REPO_DIR);
    expect(r.code).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  }, 20_000);
});

describe("wave 6 — git flows report a provider failure cleanly (never an uncaught stack trace)", () => {
  // `resolveGitProvider` only confirms the provider is REGISTERED — `mock-flaky`
  // passes that check and then genuinely throws on its one and only `stream()`
  // call (these flows never retry), exercising exactly the path a real
  // unauthenticated/offline provider would hit. Before the fix this propagated
  // uncaught past `cli.runExit()`, which rendered a raw ANSI stack trace on
  // STDOUT with exit 1 — the opposite of this codebase's "clean message on
  // stderr" convention used by every other command.
  for (const cmd of ["review", "explain", "commit", "pr"]) {
    it(`nexus ${cmd} surfaces a thrown provider error as a clean stderr message, not a stdout stack trace`, async () => {
      // A fresh, real diff every time — the shared REPO_DIR's working tree may
      // already be clean/committed by an earlier test in this file, and a
      // clean tree would short-circuit before ever reaching the provider.
      writeFileSync(join(REPO_DIR, "app.ts"), `export const flakyProbe = ${Date.now()};\n`);
      if (cmd === "commit") git(["add", "."]);
      const r = await runCli([cmd, "-p", "mock-flaky", "-m", "mock-fast"], "", REPO_DIR);
      expect(r.code).not.toBe(0);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain(`nexus ${cmd}: `);
      expect(r.stderr).toContain("mock-flaky induced failure");
      // The tell-tale signs of an unhandled exception leaking through clipanion's
      // default renderer — must be absent.
      expect(r.stderr).not.toContain("at async");
      expect(r.stderr).not.toContain("Adapter Error");
    }, 20_000);
  }
});

describe("wave 6 — git flows see an auth-derived (OAuth-only, no static providers[] entry) provider", () => {
  // `resolveGitProvider` (shared by commit/review/explain/pr) used to build its
  // runtime with plain `buildRuntime`, so a provider the user is signed into
  // ONLY via `nexus login` (no static config entry) was invisible and every
  // git flow errored `provider "anthropic" is not available (try -p mock)` —
  // even though `nexus ask -p anthropic` worked. Fixed by switching to
  // `buildAuthedRuntime` (see `packages/cli/src/wave6.ts`). One flow
  // (`explain`) is exercised here; all four share the same helper function, so
  // this one test covers the fix for all of them. `ANTHROPIC_API_KEY` stands
  // in for a resolved credential — the same branch a stored OAuth token takes
  // (see the `cli.integration.test.ts` "default 'anthropic' entry" tests).
  it('`nexus explain -p anthropic` gets PAST the "not available" gate for a signed-in-only anthropic', async () => {
    const freshConfigDir = join(mkdtempSync(join(tmpdir(), "nx-w6-fresh-")), "cfg");
    const diff = execFileSync("git", ["diff"], { cwd: REPO_DIR }).toString();
    const r = await runCli(["explain", "-p", "anthropic"], diff, WORK_DIR, {
      NEXUS_CONFIG_DIR: freshConfigDir,
      ANTHROPIC_API_KEY: "sk-ant-test-fake-key-for-registration-only",
    });
    // The bug's exact error string. Whatever anthropic does next (succeed,
    // or fail on the live call with an invalid test key) is NOT under test
    // here — only that the provider was recognized as available at all.
    expect(r.stderr).not.toContain("is not available");
  }, 20_000);
});

describe("wave 6 — git flows get the same first-run fallback as ask/chat/tui/models/agent (§ CAPABILITIES.md C6)", () => {
  // `resolveGitProvider` used to hard-fail on a fresh machine (no `-p`, no
  // usable default) with `provider "anthropic" is not available` — every
  // sibling command already degrades to `mock` with a notice instead. Also
  // exercises the `isProviderUsable` fix alongside it: the OLD `registry.has()`
  // check would have let an unconfigured-but-registered `anthropic` through
  // and failed later with a raw adapter exception instead of this clean path.
  it("`nexus commit` (no -p, fresh config, no diff piped) falls back to mock with a notice instead of erroring", async () => {
    const freshConfigDir = join(mkdtempSync(join(tmpdir(), "nx-w6-fresh-")), "cfg");
    const diff = execFileSync("git", ["diff"], { cwd: REPO_DIR }).toString();
    const r = await runCli(["commit"], diff, REPO_DIR, { NEXUS_CONFIG_DIR: freshConfigDir });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("mock");
    expect(r.stderr).not.toContain("is not available");
  }, 20_000);

  it("`nexus commit -p anthropic` (explicit, unavailable) still hard-fails clearly — only the DEFAULT path degrades", async () => {
    const freshConfigDir = join(mkdtempSync(join(tmpdir(), "nx-w6-fresh-")), "cfg");
    const diff = execFileSync("git", ["diff"], { cwd: REPO_DIR }).toString();
    const r = await runCli(["commit", "-p", "anthropic"], diff, REPO_DIR, { NEXUS_CONFIG_DIR: freshConfigDir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("anthropic");
    expect(r.stderr).toContain("not available");
  }, 20_000);
});

describe("wave 6 — session export (redaction + file perms security fixes)", () => {
  it("session export --format json writes a private (0600) file with no injected secret leaked", async () => {
    const secret = "sk-live0123456789ABCDEFghij0123456789";
    await seedMockRun(`remember DB_PASSWORD=hunter2 and key ${secret}`);
    const id = await firstSessionId();
    const out = join(WORK_DIR, "export.json");

    const r = await runCli(["session", "export", id, "--format", "json", "-o", out]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(out);
    expect(existsSync(out)).toBe(true);

    // FIX 3: the exported file is private by default, like the receipt.
    const mode = statSync(out).mode & 0o777;
    expect(mode).toBe(0o600);

    // FIX 1: the secret injected via the mock prompt/echo never leaks into JSON.
    const contents = readFileSync(out, "utf8");
    expect(contents).not.toContain(secret);
    expect(contents).not.toContain("hunter2");
    expect(contents).toContain("[REDACTED]");
    const parsed = JSON.parse(contents); // still valid, parseable JSON
    expect(parsed.session.sessionId).toBe(id);
  }, 20_000);

  it("doctor reports a git subsystem line", async () => {
    const r = await runCli(["doctor"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/\[(ok|--)\]\s+git/);
  }, 20_000);
});
