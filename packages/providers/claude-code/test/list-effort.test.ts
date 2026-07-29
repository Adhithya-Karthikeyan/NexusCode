import { describe, it, expect, beforeAll } from "vitest";
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClaudeCodeAdapter, parseClaudeEffortReply } from "@nexuscode/provider-claude-code";
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
 * A wrapped coding CLI has no effort API either, so `listReasoningLevels()`
 * runs the CLI's own `/effort` command (`claude -p "/effort" --output-format
 * json`) and parses the `Usage:` clause it reports back — the CLI telling us
 * what it accepts, not a hardcoded guess (the old CLI-wide `EffortLevel` was
 * `"off"|"low"|"medium"|"high"`, which rejected claude-code's own real
 * `xhigh`/`max`/`ultracode`/`auto`).
 */
describe("claude-code — parseClaudeEffortReply (pure parser)", () => {
  it("parses the real `claude -p \"/effort\"` reply (claude 2.1.220, 2026)", () => {
    expect(parseClaudeEffortReply("Usage: /effort <low|medium|high|xhigh|max|ultracode|auto>")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultracode",
      "auto",
    ]);
  });

  it("returns [] when there is no Usage clause at all", () => {
    expect(parseClaudeEffortReply("no usage clause here")).toEqual([]);
  });
});

describe("claude-code — listReasoningLevels (live-probed via the real `/effort` command)", () => {
  it("returns exactly the CLI's own accepted levels, unmodified, tagged \"provider\"", async () => {
    const adapter = adapterFor("success");
    const result = await adapter.listReasoningLevels!();
    expect(result.source).toBe("provider");
    expect(result.levels.map((l) => l.id)).toEqual(["low", "medium", "high", "xhigh", "max", "ultracode", "auto"]);
  });

  /**
   * The team-lead-verified fact this locks in: `claude` already emits real
   * `reasoning` events with ZERO `--effort` passed (its own session default
   * already reasons). NexusCode's "off" only omits the flag — it never sends
   * anything that would turn reasoning OFF — so a picker must not offer "off"
   * here as if it disables reasoning. True on EVERY branch (this is a static
   * fact about the wire, not a probe result), so it must hold even when the
   * probe itself fails — see the fallback-path assertions below.
   */
  it("offDisablesReasoning is FALSE — claude-code already reasons by default; --effort only selects the level", async () => {
    const adapter = adapterFor("success");
    expect((await adapter.listReasoningLevels!()).offDisablesReasoning).toBe(false);
  });

  it("degrades to an empty, \"fallback\"-tagged list (never a guess) when the probe times out", async () => {
    const adapter = adapterFor("effort-hang");
    const result = await adapter.listReasoningLevels!();
    expect(result).toEqual({ levels: [], source: "fallback", offDisablesReasoning: false });
  });

  it("degrades honestly when the CLI exits non-zero", async () => {
    const adapter = adapterFor("effort-error");
    expect(await adapter.listReasoningLevels!()).toEqual({ levels: [], source: "fallback", offDisablesReasoning: false });
  });

  it("degrades honestly when the reply is not valid JSON", async () => {
    const adapter = adapterFor("effort-malformed");
    expect(await adapter.listReasoningLevels!()).toEqual({ levels: [], source: "fallback", offDisablesReasoning: false });
  });

  it("degrades honestly when the JSON reply has no parseable Usage clause", async () => {
    const adapter = adapterFor("effort-empty");
    expect(await adapter.listReasoningLevels!()).toEqual({ levels: [], source: "fallback", offDisablesReasoning: false });
  });

  it("degrades honestly when the binary is not on PATH (no CLI spawned)", async () => {
    const adapter = createClaudeCodeAdapter({ bin: "definitely-not-a-real-claude-binary-xyz" });
    expect(await adapter.listReasoningLevels!()).toEqual({ levels: [], source: "fallback", offDisablesReasoning: false });
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
    await adapter.listReasoningLevels!();
    await adapter.listReasoningLevels!();
    await adapter.listReasoningLevels!();
    expect(spawnCount).toBe(1);
  });

  it("never sends real chat argv to the probe (uses `-p \"/effort\" --output-format json`)", async () => {
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
    await adapter.listReasoningLevels!();
    expect(capturedArgs).toEqual(["-p", "/effort", "--output-format", "json"]);
  });

  it("listReasoningLevels and listModels probe independently (each with its own cache)", async () => {
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
    await adapter.listReasoningLevels!();
    expect(spawnCount).toBe(2);
  });
});
