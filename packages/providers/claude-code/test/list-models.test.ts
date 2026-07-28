import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClaudeCodeAdapter, parseClaudeModelReply } from "@nexuscode/provider-claude-code";
import { defaultSpawn, type SpawnFn, type SpawnedChild } from "@nexuscode/provider-subprocess";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

beforeAll(() => {
  chmodSync(FAKE, 0o755);
});

function adapterFor(mode: string, extra: Record<string, unknown> = {}) {
  return createClaudeCodeAdapter({
    bin: FAKE,
    resolveEnv: async () => ({ FAKE_CLAUDE_MODE: mode }),
    listModelsTimeoutMs: 500,
    ...extra,
  });
}

/**
 * A wrapped coding CLI has no models API, so `listModels()` runs the CLI's own
 * `/model` command (`claude -p "/model" --output-format json`) and parses the
 * `Available:` list it reports — the CLI telling us what it accepts, not a
 * hardcoded guess. The prior `CLAUDE_CODE_MODELS` array was wrong twice
 * (stale ids, then missing `fable`/`best`/`sonnet[1m]`/`opus[1m]`/`fable[1m]`/
 * `opusplan` entirely) — this replaces it with a real, bounded, cached probe.
 */
describe("claude-code — parseClaudeModelReply (pure parser)", () => {
  it("parses the real `claude -p \"/model\"` reply (claude 2.1.220, 2026)", () => {
    const reply =
      "Current model: Opus 5 (1M context) (effort: xhigh)\n" +
      "Usage: /model <name>. Available: sonnet, opus, haiku, fable, best, sonnet[1m], opus[1m], fable[1m], opusplan, default, or a full model ID.";
    expect(parseClaudeModelReply(reply)).toEqual([
      "sonnet",
      "opus",
      "haiku",
      "fable",
      "best",
      "sonnet[1m]",
      "opus[1m]",
      "fable[1m]",
      "opusplan",
      "default",
    ]);
  });

  it("tolerates a line-wrapped Available clause", () => {
    const reply = "Current model: X\nUsage: /model <name>. Available: sonnet,\n  opus, or a full model ID.";
    expect(parseClaudeModelReply(reply)).toEqual(["sonnet", "opus"]);
  });

  it("returns [] when there is no Available clause at all", () => {
    expect(parseClaudeModelReply("Current model: X\nNo usage line here.")).toEqual([]);
  });
});

describe("claude-code — listModels (live-probed via the real `/model` command)", () => {
  it("returns exactly the CLI's own Available list, unmodified", async () => {
    const adapter = adapterFor("success");
    const ids = (await adapter.listModels!()).map((m) => m.id);
    expect(ids).toEqual([
      "sonnet",
      "opus",
      "haiku",
      "fable",
      "best",
      "sonnet[1m]",
      "opus[1m]",
      "fable[1m]",
      "opusplan",
      "default",
    ]);
  });

  it("unions config-driven modelMap entries on top of the live-probed list", async () => {
    const adapter = adapterFor("success", { modelMap: { custom: "claude-custom-9" } });
    const ids = (await adapter.listModels!()).map((m) => m.id);
    expect(ids).toContain("claude-custom-9");
    expect(ids).toContain("default");
    expect(ids).toContain("opus");
  });

  it("degrades to config-driven models only (never a fabricated catalog) when the probe times out", async () => {
    const adapter = adapterFor("model-hang", { modelMap: { custom: "claude-custom-9" } });
    const models = await adapter.listModels!();
    expect(models.map((m) => m.id)).toEqual(["claude-custom-9"]);
  });

  it("degrades honestly when the CLI exits non-zero", async () => {
    const adapter = adapterFor("model-error");
    expect(await adapter.listModels!()).toEqual([]);
  });

  it("degrades honestly when the reply is not valid JSON", async () => {
    const adapter = adapterFor("model-malformed");
    expect(await adapter.listModels!()).toEqual([]);
  });

  it("degrades honestly when the JSON reply has no parseable Available clause", async () => {
    const adapter = adapterFor("model-empty");
    expect(await adapter.listModels!()).toEqual([]);
  });

  it("degrades honestly when the binary is not on PATH (no CLI spawned)", async () => {
    const adapter = createClaudeCodeAdapter({ bin: "definitely-not-a-real-claude-binary-xyz" });
    expect(await adapter.listModels!()).toEqual([]);
  });

  it("caches the live probe so a picker refresh does not re-spawn the CLI", async () => {
    let spawnCount = 0;
    const spawn: SpawnFn = (bin, args, opts) => {
      spawnCount++;
      return defaultSpawn(bin, args, opts) as SpawnedChild;
    };
    const adapter = createClaudeCodeAdapter({
      bin: FAKE,
      resolveEnv: async () => ({ FAKE_CLAUDE_MODE: "success" }),
      spawn,
    });
    await adapter.listModels!();
    await adapter.listModels!();
    await adapter.listModels!();
    expect(spawnCount).toBe(1);
  });

  it("never sends real chat argv to the probe (uses `-p \"/model\" --output-format json`)", async () => {
    let capturedArgs: string[] = [];
    const spawn: SpawnFn = (bin, args, opts) => {
      capturedArgs = [...args];
      return defaultSpawn(bin, args, opts) as SpawnedChild;
    };
    const adapter = createClaudeCodeAdapter({
      bin: FAKE,
      resolveEnv: async () => ({ FAKE_CLAUDE_MODE: "success" }),
      spawn,
    });
    await adapter.listModels!();
    expect(capturedArgs).toEqual(["-p", "/model", "--output-format", "json"]);
  });
});
