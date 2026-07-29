/**
 * `--effort` end-to-end through the REAL compiled `nexus` binary (see
 * `cli.integration.test.ts` for the shared spawn pattern).
 *
 * The reported bug this closes: the macOS app's effort picker spliced
 * `--effort <level>` into its DISPLAYED command preview while no `nexus`
 * command actually accepted the flag — the exact "shown command ≠ run
 * command" lie this project already fixed once for `nexus agent` vs. `nexus
 * chat --persistent`. These tests prove the flag is real: accepted where it
 * can work, rejected loudly when malformed, and — when the resolved provider
 * cannot honor it — warned about on stderr rather than silently dropped
 * (never a "shown but not real" capability, per this project's "never a
 * silent failure" rule).
 *
 * A SECOND bug this now also closes: `--effort` used to validate against one
 * hardcoded, lowest-common-denominator vocabulary
 * (`"off"|"low"|"medium"|"high"`) for every provider, which rejected
 * claude-code's own real levels (`xhigh`/`max`/`ultracode`/`auto`) and
 * codex's (model-dependent, e.g. `minimal`/`ultra`). Legality is now
 * PROVIDER-DEPENDENT: only "off" is universal; every other value is
 * forwarded to the resolved provider (a live wire path for claude-code/codex
 * now — see `nexus code --effort`), and `nexus effort <provider>` is the
 * dedicated live-probe surface for "what does THIS provider actually accept".
 */
import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnCli } from "./helpers/spawn-cli.js";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
// The richer provider-package fixture — the ONE that also answers
// `-p "/effort" --output-format json` like the real `claude` CLI does (see
// `packages/providers/claude-code/test/fixtures/fake-claude.mjs`'s own doc) —
// reused here exactly like `chat-switch.integration.test.ts` already does for
// live `/model` probing, so `nexus effort claude-code` gets genuine
// `source: "provider"` coverage against the real compiled binary.
const RICH_FAKE_CLAUDE = fileURLToPath(
  new URL("../../providers/claude-code/test/fixtures/fake-claude.mjs", import.meta.url),
);

function freshDirs(prefix: string): { configDir: string; dataDir: string; workDir: string } {
  const configDir = join(mkdtempSync(join(tmpdir(), `${prefix}-cfg-`)), "cfg");
  const dataDir = join(mkdtempSync(join(tmpdir(), `${prefix}-data-`)), "data");
  const workDir = mkdtempSync(join(tmpdir(), `${prefix}-work-`));
  return { configDir, dataDir, workDir };
}

function runner(dirs: { configDir: string; dataDir: string; workDir: string }) {
  return (args: string[], input = "", extraEnv: Record<string, string> = {}) =>
    spawnCli(BIN, args, {
      cwd: dirs.workDir,
      input,
      env: {
        ...process.env,
        NEXUS_CONFIG_DIR: dirs.configDir,
        NEXUS_DATA_DIR: dirs.dataDir,
        NEXUSCODE_DATA_DIR: dirs.dataDir,
        NEXUS_HISTORY_DISABLED: "1",
        NEXUS_VAULT_PASSPHRASE: "test-passphrase",
        ...extraEnv,
      },
    });
}

beforeAll(() => {
  if (!existsSync(BIN)) {
    throw new Error(`CLI not built at ${BIN} — run \`npm run build\` before the test suite (CI builds first)`);
  }
});

describe("--help documents --effort", () => {
  const run = runner(freshDirs("nx-effort-help"));

  it("nexus ask --help shows --effort and points at the live per-provider scale", async () => {
    const r = await run(["ask", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--effort/);
    // The terminal wraps long usage text, so "nexus effort <provider>" can be
    // split across a line break — match loosely rather than as one literal
    // phrase (see PROVIDER-NATIVE in the details block).
    expect(r.stdout).toMatch(/nexus\s+effort/);
    expect(r.stdout).toMatch(/PROVIDER-NATIVE/);
  }, 20_000);

  it("bare `nexus` (non-TTY, the USAGE fallback) lists --effort in the shared options", async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--effort <lvl>/);
  }, 20_000);
});

describe("nexus ask --effort", () => {
  const run = runner(freshDirs("nx-effort-ask"));

  it("is accepted, and warns clearly (not silently) when mock can't honor it — the answer still comes back", async () => {
    const r = await run(["ask", "-p", "mock", "--effort", "high", "hi there"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Echo: hi there");
    expect(r.stderr).toContain('provider "mock" does not support reasoning effort');
    expect(r.stderr).toContain("--effort high");
  }, 20_000);

  it("a value no provider vocabulary happens to share (e.g. a typo) still just WARNS on an unsupported provider — legality is per-provider, not a fixed format", async () => {
    const r = await run(["ask", "-p", "mock", "--effort", "bogus", "hi there"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Echo: hi there");
    expect(r.stderr).toContain('provider "mock" does not support reasoning effort');
    expect(r.stderr).toContain("--effort bogus");
  }, 20_000);

  it("rejects a genuinely EMPTY --effort value loudly (exit 2, clear message, no request attempted)", async () => {
    const r = await run(["ask", "-p", "mock", "--effort", "", "hi there"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid --effort");
    expect(r.stdout).toBe("");
  }, 20_000);

  it("prints NO effort warning at all when --effort is not passed and mock has no reasoning mode to imply one for", async () => {
    const r = await run(["ask", "-p", "mock", "hi there"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/reasoning effort/);
  }, 20_000);

  it("-o json still reports the answer normally alongside the stderr warning", async () => {
    const r = await run(["ask", "-p", "mock", "-o", "json", "--effort", "low", "hi"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as { status: string; text: string };
    expect(obj.status).toBe("ok");
    expect(r.stderr).toContain("--effort low");
  }, 20_000);
});

describe("nexus chat --effort", () => {
  const run = runner(freshDirs("nx-effort-chat"));

  it("resolves the warning ONCE per session, not once per piped line", async () => {
    const r = await run(["chat", "-p", "mock", "--effort", "medium"], "hi\nhow are you\n");
    expect(r.code).toBe(0);
    const warnings = r.stderr.split("\n").filter((l) => l.includes("reasoning effort"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("--effort medium");
  }, 20_000);
});

describe("nexus agent --effort", () => {
  const run = runner(freshDirs("nx-effort-agent"));

  it("native tool loop: warns when the provider can't honor it", async () => {
    const r = await run(["agent", "-p", "mock", "-m", "mock-tools", "--effort", "low", "read the config"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('nexus agent: provider "mock" does not support reasoning effort');
  }, 20_000);

  it("--role (OODA) path: warns too, through the SAME shared helper", async () => {
    const r = await run([
      "agent",
      "--role",
      "researcher",
      "-p",
      "mock",
      "-m",
      "mock-tools",
      "--effort",
      "low",
      "what changed recently",
    ]);
    expect(r.stderr).toContain('nexus agent: provider "mock" does not support reasoning effort');
  }, 20_000);

  it("an unrecognized --effort value still just warns before reaching the role registry (no format gate to fail)", async () => {
    const r = await run(["agent", "--role", "researcher", "-p", "mock", "--effort", "nope", "x"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('nexus agent: provider "mock" does not support reasoning effort');
  }, 20_000);

  it("rejects a genuinely EMPTY --effort value before touching the role registry", async () => {
    const r = await run(["agent", "--role", "researcher", "-p", "mock", "--effort", "", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid --effort");
  }, 20_000);
});

describe("nexus plan --effort", () => {
  const run = runner(freshDirs("nx-effort-plan"));

  it("shares agent --role's warning (plan runs the same OODA path)", async () => {
    const r = await run(["plan", "-p", "mock", "-m", "mock-tools", "--effort", "high", "build a widget"]);
    expect(r.stderr).toContain('nexus agent: provider "mock" does not support reasoning effort');
  }, 20_000);
});

describe("nexus code --effort", () => {
  const run = runner(freshDirs("nx-effort-code"));
  beforeAll(() => {
    chmodSync(FAKE_CLAUDE, 0o755);
    chmodSync(RICH_FAKE_CLAUDE, 0o755);
  });

  it("reaches claude-code for real: --effort <level> arrives in the subprocess's own argv", async () => {
    const r = await run(
      ["code", "--agent", "claude-code", "--effort", "high", "fix the bug"],
      "",
      { NEXUS_CLAUDE_CODE_BIN: FAKE_CLAUDE },
    );
    expect(r.code).toBe(0);
    // `fake-claude.mjs` echoes `--effort <level>` into its own result text —
    // proof the flag left the CLI process and reached the wrapped CLI's argv,
    // not just an internal `SamplingParams` object.
    expect(r.stdout).toContain("effort=high");
    expect(r.stderr).not.toContain("does not support reasoning effort");
  }, 20_000);

  it("omits --effort entirely (never overrides the CLI's own configured effort) when the flag is not passed", async () => {
    const r = await run(["code", "--agent", "claude-code", "fix the bug"], "", {
      NEXUS_CLAUDE_CODE_BIN: FAKE_CLAUDE,
    });
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("effort=");
  }, 20_000);
});

describe("nexus effort <provider> — live per-provider discovery", () => {
  const run = runner(freshDirs("nx-effort-cmd"));
  beforeAll(() => {
    chmodSync(RICH_FAKE_CLAUDE, 0o755);
  });

  it("mock has no reasoning concept at all: supported:false, zero levels, no dead control", async () => {
    const r = await run(["effort", "mock", "-o", "json"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as { provider: string; supported: boolean; levels: unknown[] };
    expect(obj).toMatchObject({ provider: "mock", supported: false, levels: [] });
  }, 20_000);

  it("mock, text mode: says plainly there is no effort control, never a picker with dead entries", async () => {
    const r = await run(["effort", "mock"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no reasoning effort control/);
  }, 20_000);

  it("claude-code: live-probes the REAL /effort levels through the compiled binary, tagged source:provider", async () => {
    const r = await run(["effort", "claude-code", "-o", "json"], "", { NEXUS_CLAUDE_CODE_BIN: RICH_FAKE_CLAUDE });
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout.trim()) as {
      provider: string;
      supported: boolean;
      levels: { id: string }[];
      source: string;
    };
    expect(obj.provider).toBe("claude-code");
    expect(obj.supported).toBe(true);
    expect(obj.source).toBe("provider");
    expect(obj.levels.map((l) => l.id)).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode", "auto"]);
  }, 20_000);
});

describe("nexus compare/race/consensus/chain --effort (per-lane)", () => {
  const run = runner(freshDirs("nx-effort-multi"));

  it("compare: EVERY lane warns independently when its provider can't honor it", async () => {
    const r = await run(["compare", "-b", "mock", "-b", "mock:mock-smart", "--effort", "medium", "hi"]);
    expect(r.code).toBe(0);
    const warnings = r.stderr.split("\n").filter((l) => l.includes("reasoning effort"));
    expect(warnings.length).toBeGreaterThanOrEqual(2);
    expect(warnings.every((l) => l.includes("nexus compare"))).toBe(true);
  }, 20_000);

  it("race: warns per lane too", async () => {
    const r = await run(["race", "-b", "mock", "-b", "mock:mock-smart", "--effort", "low", "hi"]);
    expect(r.stderr).toContain("nexus race: provider");
  }, 20_000);

  it("consensus: warns per lane too", async () => {
    const r = await run(["consensus", "-b", "mock", "-b", "mock:mock-smart", "--effort", "low", "hi"]);
    expect(r.stderr).toContain("nexus consensus: provider");
  }, 20_000);

  it("chain: warns per stage too (default preset reuses one provider three times)", async () => {
    const r = await run(["chain", "-p", "mock", "--effort", "low", "build a todo app"]);
    expect(r.stderr).toContain("nexus chain: provider");
  }, 20_000);

  it("an unrecognized --effort value is forwarded per-lane, not hard-rejected up front — legality is per-provider now", async () => {
    const r = await run(["compare", "-b", "mock", "-b", "mock:mock-smart", "--effort", "extreme", "hi"]);
    expect(r.code).toBe(0);
    const warnings = r.stderr.split("\n").filter((l) => l.includes("reasoning effort"));
    expect(warnings.length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("a genuinely EMPTY --effort value is still rejected before any backend is even parsed", async () => {
    const r = await run(["compare", "-b", "mock", "-b", "mock:mock-smart", "--effort", "", "hi"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid --effort");
  }, 20_000);
});

describe("config.defaultEffort layering", () => {
  const dirs = freshDirs("nx-effort-config");
  const run = runner(dirs);

  beforeAll(() => {
    mkdirSync(dirs.configDir, { recursive: true });
    writeFileSync(join(dirs.configDir, "config.json"), JSON.stringify({ defaultEffort: "high" }));
  });

  it("--effort absent: the CONFIGURED default ('high') is what gets applied (and warned about)", async () => {
    const r = await run(["ask", "-p", "mock", "hi"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("--effort high");
  }, 20_000);

  it("--effort present: the FLAG wins over the configured default", async () => {
    const r = await run(["ask", "-p", "mock", "--effort", "off", "hi"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/reasoning effort/);
  }, 20_000);

  it("nexus config get defaultEffort reads back what was written", async () => {
    const r = await run(["config", "get", "defaultEffort"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('"high"');
  }, 20_000);
});

describe("config.defaultEffort — the BAKED-IN default ('off') is implicit, never noisy on a non-reasoning provider", () => {
  const run = runner(freshDirs("nx-effort-implicit"));

  it("no --effort flag, no configured default, mock provider: completely silent (implicit defaulting never applies to a provider with nothing to default)", async () => {
    const r = await run(["ask", "-p", "mock", "hi"]);
    expect(r.code).toBe(0);
    expect(r.stderr).not.toMatch(/reasoning effort/);
  }, 20_000);
});
