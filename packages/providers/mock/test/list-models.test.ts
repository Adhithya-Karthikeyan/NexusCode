import { describe, it, expect } from "vitest";
import {
  createMockAdapter,
  createFlakyMockAdapter,
  createSlowMockAdapter,
} from "@nexuscode/provider-mock";

/**
 * `listModels()` on the mock adapter returns ITS OWN virtual models — never any
 * other provider's catalog — fully deterministic and offline.
 */
describe("mock — listModels", () => {
  it("returns the mock's own virtual models by default", async () => {
    const adapter = createMockAdapter();
    const models = await adapter.listModels!();
    expect(models.map((m) => m.id)).toEqual(["mock-fast", "mock-smart", "mock-tools"]);
    // Every entry carries the mock's static metadata.
    for (const m of models) {
      expect(m.contextWindow).toBe(32_000);
      expect(m.modalities).toEqual(["text"]);
    }
  });

  it("reflects a custom model set", async () => {
    const adapter = createMockAdapter({ models: ["only-me"] });
    const models = await adapter.listModels!();
    expect(models.map((m) => m.id)).toEqual(["only-me"]);
  });

  it("matches capabilities().models exactly (single source of truth)", async () => {
    const adapter = createMockAdapter();
    const listed = await adapter.listModels!();
    const caps = await adapter.capabilities();
    expect(listed).toEqual(caps.models);
  });

  it("flaky and slow variants also expose their own virtual models", async () => {
    const flaky = createFlakyMockAdapter();
    const slow = createSlowMockAdapter();
    expect((await flaky.listModels!()).map((m) => m.id)).toEqual([
      "mock-fast",
      "mock-smart",
      "mock-tools",
    ]);
    expect((await slow.listModels!()).map((m) => m.id)).toEqual([
      "mock-fast",
      "mock-smart",
      "mock-tools",
    ]);
  });
});
