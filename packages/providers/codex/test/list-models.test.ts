import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCodexAdapter, buildCodexArgs } from "@nexuscode/provider-codex";
import { defaultSpawn, type SpawnFn, type SpawnedChild } from "@nexuscode/provider-subprocess";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url));

beforeAll(() => {
  chmodSync(FAKE, 0o755);
});

function adapterFor(mode: string, extra: Record<string, unknown> = {}) {
  return createCodexAdapter({
    bin: FAKE,
    resolveEnv: async () => ({ FAKE_CODEX_MODE: mode }),
    listModelsTimeoutMs: 500,
    ...extra,
  });
}

/**
 * `codex` has no enumerable model list — `-m/--model` takes a free-form
 * string and there is no `codex models`/`--list-models` (verified against
 * `codex --help`/`codex exec --help`, codex-cli 0.145.0). The prior
 * `CODEX_MODELS` array (`gpt-5-codex, o4-mini, o3, gpt-4.1,
 * codex-mini-latest`) was a fabricated guess that named ids nowhere close to
 * what codex was actually configured to run. This replaces it: `"default"`
 * (always legitimate — `buildArgs` omits `--model` for it, letting codex use
 * its own `~/.codex/config.toml`), plus the ACTUAL configured model read
 * read-only via `codex doctor --json`'s `checks["config.load"].details.model`.
 */
describe("codex — listModels (live-probed via `codex doctor --json`)", () => {
  it("reports the CLI's own configured model plus the default sentinel", async () => {
    const adapter = adapterFor("doctor-success");
    const ids = (await adapter.listModels!()).map((m) => m.id);
    expect(ids).toEqual(["default", "gpt-5.6-fake"]);
    // Never any of the old fabricated ids.
    expect(ids).not.toContain("gpt-5-codex");
    expect(ids).not.toContain("o4-mini");
    expect(ids).not.toContain("o3");
    expect(ids).not.toContain("gpt-4.1");
    expect(ids).not.toContain("codex-mini-latest");
  });

  it("unions config-driven modelMap entries on top of the live-probed result", async () => {
    const adapter = adapterFor("doctor-success", { modelMap: { custom: "gpt-custom-9" } });
    const ids = (await adapter.listModels!()).map((m) => m.id);
    expect(ids).toContain("gpt-custom-9");
    expect(ids).toContain("default");
    expect(ids).toContain("gpt-5.6-fake");
  });

  it("falls back to just \"default\" (never a fabricated id) when the probe times out", async () => {
    const adapter = adapterFor("doctor-hang");
    expect((await adapter.listModels!()).map((m) => m.id)).toEqual(["default"]);
  });

  it("falls back to just \"default\" when doctor exits non-zero", async () => {
    const adapter = adapterFor("doctor-error");
    expect((await adapter.listModels!()).map((m) => m.id)).toEqual(["default"]);
  });

  it("falls back to just \"default\" when the doctor report is not valid JSON", async () => {
    const adapter = adapterFor("doctor-malformed");
    expect((await adapter.listModels!()).map((m) => m.id)).toEqual(["default"]);
  });

  it("falls back to just \"default\" when the doctor report has no resolvable model", async () => {
    const adapter = adapterFor("doctor-no-model");
    expect((await adapter.listModels!()).map((m) => m.id)).toEqual(["default"]);
  });

  it("falls back to just \"default\" when the binary is not on PATH (no CLI spawned)", async () => {
    const adapter = createCodexAdapter({ bin: "definitely-not-a-real-codex-binary-xyz" });
    expect((await adapter.listModels!()).map((m) => m.id)).toEqual(["default"]);
  });

  it("caches the live probe so a picker refresh does not re-spawn the CLI", async () => {
    let spawnCount = 0;
    const spawn: SpawnFn = (bin, args, opts) => {
      spawnCount++;
      return defaultSpawn(bin, args, opts) as SpawnedChild;
    };
    const adapter = createCodexAdapter({
      bin: FAKE,
      resolveEnv: async () => ({ FAKE_CODEX_MODE: "doctor-success" }),
      spawn,
    });
    await adapter.listModels!();
    await adapter.listModels!();
    await adapter.listModels!();
    expect(spawnCount).toBe(1);
  });

  it("probes via `doctor --json`, never `exec` (no chat turn, no API cost)", async () => {
    let capturedArgs: string[] = [];
    const spawn: SpawnFn = (bin, args, opts) => {
      capturedArgs = [...args];
      return defaultSpawn(bin, args, opts) as SpawnedChild;
    };
    const adapter = createCodexAdapter({
      bin: FAKE,
      resolveEnv: async () => ({ FAKE_CODEX_MODE: "doctor-success" }),
      spawn,
    });
    await adapter.listModels!();
    expect(capturedArgs).toEqual(["doctor", "--json"]);
  });

  it("selecting \"default\" omits --model entirely (codex has no verified default keyword)", () => {
    const args = buildCodexArgs({}, { model: "default", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] });
    expect(args).not.toContain("--model");
  });
});
