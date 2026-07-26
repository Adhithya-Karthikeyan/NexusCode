/**
 * `ProviderRegistry.recordDiscoveredModels` — folding a provider's REAL model
 * list into its capabilities.
 *
 * `capabilities().models` is a curated snapshot (Anthropic ships a handful of
 * undated aliases) while `adapter.listModels()` returns the dated ids users
 * actually pick. Every "does this provider have this model?" question reads
 * `capabilitiesOf`, so an unmerged discovered model was treated as unknown
 * system-wide — and `assessSwitchTarget` marked it INCOMPATIBLE, which silently
 * skipped the context-window compaction that makes a provider switch safe.
 */
import { describe, it, expect } from "vitest";
import type { ChatRequest, ProviderAdapter } from "../src/index.js";
import { ProviderRegistry, assessSwitchTarget, inferSwitchRequirements } from "../src/index.js";

function adapter(id: string, models: { id: string; contextWindow?: number }[]): ProviderAdapter {
  return {
    id,
    label: id,
    transport: "http-sdk",
    capabilities: async () => ({
      models,
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      vision: false,
      structuredOutput: false,
      reasoning: false,
      systemPrompt: true,
      fileEdit: false,
      shellExec: false,
      git: false,
      approvalGate: false,
      mcp: false,
      cancel: "abort-signal",
    }),
    chat: async () => {
      throw new Error("unused");
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("unused");
    },
  };
}

async function registryWith(curated: { id: string; contextWindow?: number }[]) {
  const registry = new ProviderRegistry();
  await registry.register(adapter("p", curated), { skipHealth: true });
  return registry;
}

const REQUEST: ChatRequest = {
  model: "irrelevant",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
};

describe("recordDiscoveredModels", () => {
  it("adds live-discovered models the curated snapshot never listed", async () => {
    const registry = await registryWith([{ id: "claude-sonnet-4-5", contextWindow: 200_000 }]);
    expect(registry.capabilitiesOf("p").models.map((m) => m.id)).toEqual(["claude-sonnet-4-5"]);

    registry.recordDiscoveredModels("p", [
      { id: "claude-opus-4-5-20251101", contextWindow: 1_000_000 },
      { id: "claude-haiku-4-5-20251001" },
    ]);

    const ids = registry.capabilitiesOf("p").models.map((m) => m.id);
    expect(ids).toContain("claude-opus-4-5-20251101");
    expect(ids).toContain("claude-haiku-4-5-20251001");
  });

  it("keeps the curated model FIRST so the default-model pick never changes", async () => {
    const registry = await registryWith([{ id: "curated-default" }]);
    registry.recordDiscoveredModels("p", [{ id: "aaa-sorts-first" }, { id: "curated-default" }]);
    expect(registry.capabilitiesOf("p").models[0]?.id).toBe("curated-default");
  });

  it("is idempotent — recording the same list twice adds nothing", async () => {
    const registry = await registryWith([{ id: "curated" }]);
    const live = [{ id: "live-1" }, { id: "live-2" }];
    registry.recordDiscoveredModels("p", live);
    const after = registry.capabilitiesOf("p").models.length;
    registry.recordDiscoveredModels("p", live);
    registry.recordDiscoveredModels("p", live);
    expect(registry.capabilitiesOf("p").models).toHaveLength(after);
  });

  it("lets discovery fill in a context window the curated entry lacked", async () => {
    const registry = await registryWith([{ id: "curated" }]);
    registry.recordDiscoveredModels("p", [{ id: "curated", contextWindow: 400_000 }]);
    const model = registry.capabilitiesOf("p").models.find((m) => m.id === "curated");
    expect(model?.contextWindow).toBe(400_000);
  });

  it("ignores unknown providers and empty lists instead of throwing", async () => {
    const registry = await registryWith([{ id: "curated" }]);
    expect(() => registry.recordDiscoveredModels("nope", [{ id: "x" }])).not.toThrow();
    expect(() => registry.recordDiscoveredModels("p", [])).not.toThrow();
  });

  it("makes a discovered model COMPATIBLE for a switch, so compaction runs", async () => {
    const registry = await registryWith([{ id: "claude-sonnet-4-5", contextWindow: 200_000 }]);
    const requirements = inferSwitchRequirements(REQUEST);

    // Before discovery: the live id is rejected and carries no context window,
    // so `adaptRequestForSwitch` is skipped and nothing is compacted.
    const before = assessSwitchTarget(
      "p",
      "claude-opus-4-5-20251101",
      registry.capabilitiesOf("p"),
      requirements,
    );
    expect(before.compatible).toBe(false);
    expect(before.blockers.join(" ")).toContain("not advertised");

    registry.recordDiscoveredModels("p", [
      { id: "claude-opus-4-5-20251101", contextWindow: 1_000_000 },
    ]);

    const after = assessSwitchTarget(
      "p",
      "claude-opus-4-5-20251101",
      registry.capabilitiesOf("p"),
      requirements,
    );
    expect(after.compatible).toBe(true);
    expect(after.contextWindow).toBe(1_000_000);
  });
});
