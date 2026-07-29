import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCodexAdapter } from "@nexuscode/provider-codex";
import { defaultSpawn, type SpawnFn, type SpawnedChild } from "@nexuscode/provider-subprocess";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

beforeAll(() => {
  chmodSync(FAKE, 0o755);
});

/**
 * `readConfiguredCodexEffort`'s last-resort fallback reads `$CODEX_HOME/
 * config.toml` directly (no subprocess) — resolved through `cfg.resolveEnv`,
 * NOT the ambient host env, so these tests must inject an isolated
 * `CODEX_HOME` or they would silently read whatever `~/.codex/config.toml`
 * happens to exist on the machine actually running the suite.
 */
function isolatedCodexHome(tomlBody?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nx-codex-home-"));
  if (tomlBody !== undefined) writeFileSync(join(dir, "config.toml"), tomlBody);
  return dir;
}

function adapterFor(mode: string, extra: Record<string, unknown> = {}) {
  const codexHome = isolatedCodexHome(); // empty — no config.toml fallback available
  return createCodexAdapter({
    bin: FAKE,
    resolveEnv: async () => ({ FAKE_CODEX_MODE: mode, CODEX_HOME: codexHome }),
    listModelsTimeoutMs: 500,
    ...extra,
  });
}

/**
 * `codex` has no `--reasoning-effort` flag and, unlike claude-code's `/effort`,
 * no single command that just answers "what levels do you accept" — the real
 * per-MODEL scale lives in `codex debug models --bundled`'s catalog (verified
 * live: codex-cli 0.145.0, `gpt-5.6-sol`'s `supported_reasoning_levels` is
 * `low|medium|high|xhigh|max|ultra`). `listReasoningLevels()` resolves the
 * CONFIGURED model via `doctor --json` (the existing, network-free probe
 * `listModels()` already uses) and looks it up in that catalog.
 */
describe("codex — listReasoningLevels (live-probed via `codex debug models --bundled`)", () => {
  it("returns the configured model's real levels + default, tagged \"provider\"", async () => {
    const adapter = adapterFor("doctor-success");
    const result = await adapter.listReasoningLevels!();
    expect(result.source).toBe("provider");
    expect(result.defaultLevel).toBe("low");
    expect(result.levels).toEqual([
      { id: "low", description: "Fast responses with lighter reasoning" },
      { id: "medium", description: "Balances speed and reasoning depth" },
      { id: "high", description: "Greater reasoning depth" },
      { id: "xhigh", description: "Extra high reasoning depth" },
    ]);
  });

  /**
   * The team-lead-verified fact this locks in: `~/.codex/config.toml` already
   * had `model_reasoning_effort = "xhigh"` configured with ZERO flags passed
   * on this run — codex already reasons by default. NexusCode's "off" only
   * omits the `-c model_reasoning_effort=…` override — it never sends
   * anything that would turn reasoning OFF — so a picker must not offer
   * "off" here as if it disables reasoning.
   */
  it("offDisablesReasoning is FALSE — codex already reasons by default; --effort only selects the level", async () => {
    const adapter = adapterFor("doctor-success");
    expect((await adapter.listReasoningLevels!()).offDisablesReasoning).toBe(false);
  });

  it("falls back to the value written in config.toml (never a guess) when the catalog probe times out", async () => {
    const dir = isolatedCodexHome('model = "gpt-5.6-fake"\nmodel_reasoning_effort = "xhigh"\n');
    const adapter = createCodexAdapter({
      bin: FAKE,
      resolveEnv: async () => ({ FAKE_CODEX_MODE: "debugmodels-hang", CODEX_HOME: dir }),
      listModelsTimeoutMs: 500,
    });
    const result = await adapter.listReasoningLevels!();
    expect(result).toEqual({ levels: [{ id: "xhigh" }], defaultLevel: "xhigh", source: "fallback", offDisablesReasoning: false });
  });

  it("falls back to config.toml when the catalog has no entry for the configured model", async () => {
    const dir = isolatedCodexHome('model_reasoning_effort = "medium"\n');
    const adapter = createCodexAdapter({
      bin: FAKE,
      resolveEnv: async () => ({ FAKE_CODEX_MODE: "debugmodels-no-match", CODEX_HOME: dir }),
      listModelsTimeoutMs: 500,
    });
    expect(await adapter.listReasoningLevels!()).toEqual({
      levels: [{ id: "medium" }],
      defaultLevel: "medium",
      source: "fallback",
      offDisablesReasoning: false,
    });
  });

  it("falls back to an empty list (never invented options) when neither the catalog nor config.toml resolve", async () => {
    const adapter = adapterFor("debugmodels-no-levels"); // empty codex home, no config.toml at all
    expect(await adapter.listReasoningLevels!()).toEqual({ levels: [], source: "fallback", offDisablesReasoning: false });
  });

  it("falls back honestly when the catalog reply is not valid JSON", async () => {
    const adapter = adapterFor("debugmodels-malformed");
    expect(await adapter.listReasoningLevels!()).toEqual({ levels: [], source: "fallback", offDisablesReasoning: false });
  });

  it("falls back honestly when the catalog probe exits non-zero", async () => {
    const adapter = adapterFor("debugmodels-error");
    expect(await adapter.listReasoningLevels!()).toEqual({ levels: [], source: "fallback", offDisablesReasoning: false });
  });

  it("falls back to an empty list when the configured model itself can't be resolved (doctor fails) and config.toml has nothing either", async () => {
    const adapter = adapterFor("doctor-hang");
    expect(await adapter.listReasoningLevels!()).toEqual({ levels: [], source: "fallback", offDisablesReasoning: false });
  });

  it("degrades honestly when the binary is not on PATH (no CLI spawned)", async () => {
    const dir = isolatedCodexHome();
    const adapter = createCodexAdapter({ bin: "definitely-not-a-real-codex-binary-xyz", resolveEnv: async () => ({ CODEX_HOME: dir }) });
    expect(await adapter.listReasoningLevels!()).toEqual({ levels: [], source: "fallback", offDisablesReasoning: false });
  });

  it("uses --bundled (no network dependency) rather than a live catalog refresh", async () => {
    let capturedArgs: string[] = [];
    const codexHome = isolatedCodexHome();
    const spawn: SpawnFn = (bin, args, opts) => {
      if (args[0] === "debug") capturedArgs = [...args];
      return defaultSpawn(bin, args, opts) as SpawnedChild;
    };
    const adapter = createCodexAdapter({
      bin: FAKE,
      resolveEnv: async () => ({ FAKE_CODEX_MODE: "doctor-success", CODEX_HOME: codexHome }),
      spawn,
    });
    await adapter.listReasoningLevels!();
    expect(capturedArgs).toEqual(["debug", "models", "--bundled"]);
  });

  it("caches the live probe so a picker refresh does not re-spawn codex", async () => {
    let spawnCount = 0;
    const codexHome = isolatedCodexHome();
    const spawn: SpawnFn = (bin, args, opts) => {
      spawnCount++;
      return defaultSpawn(bin, args, opts) as SpawnedChild;
    };
    const adapter = createCodexAdapter({
      bin: FAKE,
      resolveEnv: async () => ({ FAKE_CODEX_MODE: "doctor-success", CODEX_HOME: codexHome }),
      spawn,
    });
    await adapter.listReasoningLevels!();
    await adapter.listReasoningLevels!();
    expect(spawnCount).toBe(2); // one `doctor` + one `debug models`, not re-run on the 2nd call
  });
});
