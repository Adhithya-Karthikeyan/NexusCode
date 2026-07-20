/**
 * Command + flag + provider consistency regressions (bugs #1–#5), all exercised
 * by SPAWNING the built `nexus` binary and asserting real output — never a mock
 * unit call. These pin the user-facing contract the earlier mock-heavy tests
 * missed:
 *   #1  the bare/default command (and `tui`) ACCEPT -p/--provider, --theme,
 *       --preset like `ask` does — `nexus -p mock` must reach the TUI's
 *       non-TTY linear fallback, not "Unsupported option name (-p)".
 *   #2  the claude-code subprocess provider works for a one-shot `ask` and in
 *       `chat` (spawn the vendor CLI, stream) — and NEVER forces a bogus
 *       `--model claude-code` on the vendor CLI.
 *   #3  `chat` uses the SAME graceful default-provider fallback as `ask` — it
 *       never dead-ends with "provider anthropic not available".
 *   #4  `nexus models [provider]` exists and lists models — no "Extraneous
 *       positional argument".
 *   #5  `nexus login` on a non-TTY prints clear guidance and exits 0 (not the
 *       exit-2 crash after the picker).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const CONFIG_DIR = join(mkdtempSync(join(tmpdir(), "nx-cfc-cfg-")), "cfg");
const DATA_DIR = join(mkdtempSync(join(tmpdir(), "nx-cfc-data-")), "data");
const WORK_DIR = mkdtempSync(join(tmpdir(), "nx-cfc-cwd-"));

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], input = "", extraEnv: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: WORK_DIR,
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: CONFIG_DIR,
        NEXUS_DATA_DIR: DATA_DIR,
        NEXUSCODE_DATA_DIR: DATA_DIR,
        NEXUS_HISTORY_DISABLED: "1",
        NEXUS_VAULT_PASSPHRASE: "test-passphrase",
        ...extraEnv,
      },
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
    child.stdin.end(input);
  });
}

// Force the coding CLIs absent by default so the degradation paths are
// deterministic regardless of what is installed on the host.
const ABSENT_BINS = {
  NEXUS_CLAUDE_CODE_BIN: "/nonexistent/nx-absent-claude",
  NEXUS_CODEX_BIN: "/nonexistent/nx-absent-codex",
};

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite (CI builds first)`);
  }
  chmodSync(FAKE_CLAUDE, 0o755);
});

describe("#1 bare/default command + tui accept run flags (-p/--provider/--theme/--preset)", () => {
  it("`nexus -p mock` (non-TTY) reaches the TUI linear fallback, NOT a -p syntax error", async () => {
    const r = await runCli(["-p", "mock"]);
    expect(r.code).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).not.toMatch(/Unsupported option name/i);
    expect(combined).toMatch(/linear mode/i);
  }, 20_000);

  it("`nexus -p claude-code` (non-TTY) is accepted too — no -p syntax error", async () => {
    const r = await runCli(["-p", "claude-code"], "", ABSENT_BINS);
    expect(r.code).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).not.toMatch(/Unsupported option name/i);
    expect(combined).toMatch(/linear mode/i);
  }, 20_000);

  it("`nexus --theme … --preset …` is accepted (same flag grammar as tui/ask)", async () => {
    const r = await runCli(["--theme", "nexus-noir", "--preset", "compare"]);
    expect(r.code).toBe(0);
    const combined = r.stdout + r.stderr;
    expect(combined).not.toMatch(/Unsupported option name/i);
    expect(combined).toMatch(/linear mode/i);
  }, 20_000);

  it("`nexus tui -p mock` accepts -p as well (consistency with the bare command)", async () => {
    const r = await runCli(["tui", "-p", "mock"]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/Unsupported option name/i);
  }, 20_000);

  it("truly bare `nexus` on a non-TTY still prints usage (unchanged)", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage: nexus/);
  }, 20_000);
});

describe("#2 claude-code subprocess provider works everywhere -p works", () => {
  it("`ask -p mock` still works (regression)", async () => {
    const r = await runCli(["ask", "-p", "mock", "hi there"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Echo: hi there");
  }, 20_000);

  it("`ask -p claude-code` drives the vendor CLI and streams (fake bin), exit 0", async () => {
    const r = await runCli(["ask", "-p", "claude-code", "hi"], "", { NEXUS_CLAUDE_CODE_BIN: FAKE_CLAUDE });
    expect(r.code).toBe(0);
    // The fake claude emits a text delta — proving the subprocess path streamed.
    expect(r.stdout).toContain("Editing app.ts.");
  }, 20_000);

  it("`ask -p claude-code` with no -m does NOT force a bogus `--model claude-code`", async () => {
    // finish=stop (success) instead of the old finish=error proves the vendor CLI
    // was not handed an invalid model id equal to the provider id.
    const r = await runCli(["ask", "-p", "claude-code", "hi"], "", { NEXUS_CLAUDE_CODE_BIN: FAKE_CLAUDE });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/finish=stop/);
    expect(r.stderr).not.toMatch(/claude-code:claude-code/);
  }, 20_000);

  it("`chat -p claude-code` also drives the subprocess provider (fake bin)", async () => {
    const r = await runCli(["chat", "-p", "claude-code"], "hi\n", { NEXUS_CLAUDE_CODE_BIN: FAKE_CLAUDE });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Editing app.ts.");
  }, 20_000);
});

describe("#3 chat uses the same graceful default-provider fallback as ask", () => {
  it("bare `chat` (no -p) falls back to an available provider with a notice — never dead-ends", async () => {
    const freshConfigDir = join(mkdtempSync(join(tmpdir(), "nx-cfc-fresh-")), "cfg");
    const r = await runCli(["chat"], "hi\n", { NEXUS_CONFIG_DIR: freshConfigDir });
    expect(r.code).toBe(0);
    // Fell back off the unconfigured default (anthropic) to the offline mock.
    expect(r.stderr).toContain("mock");
    expect(r.stderr).not.toMatch(/provider "anthropic" not available/);
    expect(r.stdout).toContain("Echo: hi");
  }, 20_000);

  it("explicit `chat -p anthropic` still errors clearly when unavailable (explicit path unchanged)", async () => {
    const freshConfigDir = join(mkdtempSync(join(tmpdir(), "nx-cfc-fresh2-")), "cfg");
    const r = await runCli(["chat", "-p", "anthropic"], "hi\n", { NEXUS_CONFIG_DIR: freshConfigDir });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/anthropic/);
    expect(r.stderr).toMatch(/not available/);
  }, 20_000);
});

describe("#4 `nexus models [provider]` exists and lists models", () => {
  it("`models` scopes to the ACTIVE provider (graceful fallback, no Extraneous positional, no global dump)", async () => {
    const r = await runCli(["models"]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/Extraneous positional argument/i);
    // With no login/keys the configured default (anthropic) isn't usable, so the
    // no-arg path degrades to the offline `mock` provider (same policy as `ask`).
    // Either way the listing is scoped to ONE provider — never the whole
    // cross-provider catalog, so other providers' models never leak in.
    expect(r.stdout).toMatch(/^mock \(mock\)/m);
    expect(r.stdout).toMatch(/mock-fast/);
    expect(r.stdout).not.toMatch(/gpt-4o/);
    expect(r.stdout).not.toMatch(/gemini-2\.0-flash/);
  }, 20_000);

  it("`models mock` scopes to one provider (mock models only)", async () => {
    const r = await runCli(["models", "mock"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/mock-fast/);
    // Scoped — no other provider's models leak in.
    expect(r.stdout).not.toMatch(/gpt-4o/);
    expect(r.stdout).not.toMatch(/gemini-2\.0-flash/);
  }, 20_000);

  it("`models mock -o json` emits ONE provider-scoped object with its models", async () => {
    const r = await runCli(["models", "mock", "-o", "json"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as { provider: string; models: { id: string }[] };
    expect(obj.provider).toBe("mock");
    expect(Array.isArray(obj.models)).toBe(true);
    expect(obj.models.map((m) => m.id)).toContain("mock-fast");
  }, 20_000);

  it("`models <unknown>` errors clearly (exit 1)", async () => {
    const r = await runCli(["models", "does-not-exist"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not available/);
  }, 20_000);
});

describe("#5 login degrades gracefully on a non-TTY", () => {
  it("`login` with no provider on a non-TTY prints clear guidance and exits 0 (not exit 2)", async () => {
    const r = await runCli(["login"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/nexus login <provider>/);
    expect(r.stderr).toMatch(/needs a terminal/);
  }, 20_000);
});

describe("#6 an unknown/mistyped command fails clearly (not a silent TUI fallback)", () => {
  it("`nexus git review` (git is not a command) errors with a human-readable message, exit 1", async () => {
    const r = await runCli(["git", "review", "-p", "mock"]);
    expect(r.code).toBe(1);
    // NOT the old behavior: silently routing to the TUI's linear-mode fallback
    // and dropping the words the user typed.
    expect(r.stdout + r.stderr).not.toMatch(/linear mode/i);
    expect(r.stderr).toMatch(/unknown command "git"/);
    // Points the user at the REAL git-diff commands.
    expect(r.stderr).toMatch(/nexus review/);
  }, 20_000);

  it("`nexus git diff` maps to the same clear guidance (any git subcommand)", async () => {
    const r = await runCli(["git", "diff"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown command "git"/);
    expect(r.stderr).toMatch(/git diff \| nexus review/);
  }, 20_000);

  it("an arbitrary unknown command errors generically (points at --help), exit 1", async () => {
    const r = await runCli(["frobnicate", "the", "widget"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown command "frobnicate"/);
    expect(r.stderr).toMatch(/nexus --help/);
  }, 20_000);

  it("flags-only bare `nexus -p mock` is UNAFFECTED — still reaches the TUI linear fallback (exit 0)", async () => {
    const r = await runCli(["-p", "mock"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/unknown command/);
    expect(r.stdout + r.stderr).toMatch(/linear mode/i);
  }, 20_000);
});

describe("#7 `plan` phase narration is one line per phase (not a run-on blob)", () => {
  it("OODA phase lines are newline-separated on stderr — never concatenated together", async () => {
    const r = await runCli(["plan", "hi", "-p", "mock", "-m", "mock-fast"]);
    expect(r.code).toBe(0);
    // Each phase is its OWN line: the previous bug ran them together as
    // "…and plan.Plan updated (1 edit).Goal satisfied…Progress: 100%Run finished…".
    expect(r.stderr).toMatch(/observing context and plan\.\n/);
    expect(r.stderr).toMatch(/\nPlan updated \(1 edit\)\.\n/);
    // Outcome-agnostic on purpose: this test is about line separation, not about
    // which verdict the run reaches (against the echo mock the goal is not
    // verifiable, so the honest terminal line is "indeterminate").
    expect(r.stderr).toMatch(/\nRun finished: [a-z-]+\.\n/);
    // The specific run-on concatenations must NOT appear.
    expect(r.stderr).not.toMatch(/plan\.Plan updated/);
    expect(r.stderr).not.toMatch(/100%Run finished/);
    // The plan tree still renders on stdout.
    expect(r.stdout).toMatch(/plan for: hi/);
  }, 20_000);
});

describe("#8 every dispatch path routes a subprocess provider through resolveRunModel (never --model <providerId>)", () => {
  // The fake claude fixture simulates the real vendor CLI's 404 whenever it is
  // handed `--model claude-code` — the exact bug where a resolver falls back
  // to `explicit ?? config.defaultModel ?? providerId`, inventing a bogus
  // model id equal to the provider's own name. These call sites (agent --role,
  // compare, race/consensus/chain's shared backendRuns) were missed when `ask`
  // and `code` were first fixed to use resolveRunModel.
  it("`agent --role coder -p claude-code` with no -m never sends the vendor CLI its own provider id as --model", async () => {
    const r = await runCli(
      ["agent", "--role", "coder", "-p", "claude-code", "--max-steps", "1", "reply pong"],
      "",
      { NEXUS_CLAUDE_CODE_BIN: FAKE_CLAUDE },
    );
    expect(r.stdout + r.stderr).not.toMatch(/model not found: claude-code/);
  }, 20_000);

  it("`compare` with a claude-code lane and no explicit model never sends --model claude-code", async () => {
    const r = await runCli(
      ["compare", "reply pong", "-b", "claude-code", "-b", "mock:mock-fast"],
      "",
      { NEXUS_CLAUDE_CODE_BIN: FAKE_CLAUDE },
    );
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/model not found: claude-code/);
    // Both lanes ran: the mock lane's echo AND the claude-code lane's streamed text.
    expect(r.stdout).toContain("Editing app.ts.");
  }, 20_000);

  it("`race` with a claude-code backend and no explicit model never sends --model claude-code", async () => {
    const r = await runCli(
      ["race", "reply pong", "-b", "claude-code", "-b", "mock:mock-fast"],
      "",
      { NEXUS_CLAUDE_CODE_BIN: FAKE_CLAUDE },
    );
    expect(r.stdout + r.stderr).not.toMatch(/model not found: claude-code/);
  }, 20_000);
});

describe("#9 a typo'd/unknown flag is warned about instead of silently ignored", () => {
  it("`ask -p mock --modle gpt \"hi\"` still runs (warn, don't hard-error) but prints a visible warning", async () => {
    const r = await runCli(["ask", "-p", "mock", "--modle", "gpt", "hi"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/warning: unknown flag\(s\) ignored:.*--modle/);
    expect(r.stderr).toMatch(/did you mean --model\?/);
  }, 20_000);

  it("a fully recognized invocation prints no unknown-flag warning (no false positives)", async () => {
    const r = await runCli(["ask", "-p", "mock", "hi there"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/unknown flag/);
  }, 20_000);
});

describe("#10 `ask -h` shows help and exits 0 without running a completion (regression)", () => {
  it("prints usage and exits 0 — never dispatches a real completion", async () => {
    const r = await runCli(["ask", "-h"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/One-shot completion/i);
    expect(r.stdout + r.stderr).not.toMatch(/Echo:/);
  }, 20_000);
});
