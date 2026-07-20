/**
 * `listModelsForProvider` (packages/cli/src/runtime.ts) — the runtime helper the
 * TUI `/model` picker calls to scope its list to ONE provider (the fix for the
 * bug where `/model` dumped the whole global catalog).
 *
 * Driven against a real, offline `buildRuntime` (mock catalog, no network, no
 * keys) so the real behavior is exercised:
 *   - a provider with no live `listModels()` (mock) yields its curated
 *     `capabilities().models`, scoped to that provider only;
 *   - an unknown provider yields an empty list (never throws);
 *   - a provider whose live `listModels()` throws degrades gracefully to the
 *     curated fallback;
 *   - a provider whose live `listModels()` succeeds wins over the static curated
 *     list.
 */
import { describe, it, expect } from "vitest";
import { NexusConfig, type SecretStore } from "@nexuscode/config";
import { buildRuntime } from "@nexuscode/runtime";
import type { CallContext, ModelInfo, ProviderAdapter } from "@nexuscode/core";
import { listModelsForProvider } from "../src/runtime.js";

const stubSecrets: SecretStore = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  source: async () => null,
};

async function offlineRuntime() {
  const config = NexusConfig.parse({ defaultProvider: "mock" });
  return buildRuntime(config, { secrets: stubSecrets });
}

describe("listModelsForProvider — provider-scoped model discovery (offline)", () => {
  it("returns ONLY the mock provider's curated models (mock has no live listModels)", async () => {
    const runtime = await offlineRuntime();
    const rows = await listModelsForProvider(runtime, "mock");

    expect(rows.length).toBeGreaterThan(0);
    // Every row belongs to the requested provider — never a cross-provider dump.
    expect(rows.every((r) => r.provider === "mock")).toBe(true);
    const ids = rows.map((r) => r.model);
    expect(ids).toContain("mock-fast");
    // No other provider's models leak in.
    expect(ids.some((id) => id.includes("gpt") || id.includes("gemini"))).toBe(false);
  });

  it("returns an empty list for an unknown provider (never throws)", async () => {
    const runtime = await offlineRuntime();
    await expect(listModelsForProvider(runtime, "totally-unknown")).resolves.toEqual([]);
  });

  it("prefers a live listModels() result over the curated static catalog", async () => {
    const runtime = await offlineRuntime();
    // Register a fake provider whose live discovery returns a real list.
    const live: ProviderAdapter = {
      id: "fake-live",
      label: "Fake Live",
      transport: "http-sdk",
      capabilities: async () => ({
        models: [{ id: "curated-only" }],
        streaming: true,
        tools: false,
        parallelToolCalls: false,
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
      listModels: async (_ctx?: CallContext): Promise<ModelInfo[]> => [
        { id: "live-a", contextWindow: 128_000 },
        { id: "live-b" },
      ],
    };
    await runtime.registry.register(live, { skipHealth: true });

    const rows = await listModelsForProvider(runtime, "fake-live");
    expect(rows.map((r) => r.model)).toEqual(["live-a", "live-b"]);
    // contextWindow becomes a human hint.
    expect(rows[0]?.hint).toBe("128k ctx");
  });

  it("degrades to the curated fallback when live listModels() throws", async () => {
    const runtime = await offlineRuntime();
    const boom: ProviderAdapter = {
      id: "fake-boom",
      label: "Fake Boom",
      transport: "http-sdk",
      capabilities: async () => ({
        models: [{ id: "curated-fallback" }],
        streaming: true,
        tools: false,
        parallelToolCalls: false,
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
      listModels: async (): Promise<ModelInfo[]> => {
        throw new Error("offline / no key");
      },
    };
    await runtime.registry.register(boom, { skipHealth: true });

    const rows = await listModelsForProvider(runtime, "fake-boom");
    expect(rows.map((r) => r.model)).toEqual(["curated-fallback"]);
    expect(rows.every((r) => r.provider === "fake-boom")).toBe(true);
  });
});
