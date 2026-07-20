import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import {
  createOpenAICompatAdapter,
  createOpenAIAdapter,
  DEFAULT_OPENAI_MODELS,
} from "@nexuscode/provider-openai";
import type { ModelInfo } from "@nexuscode/core";

/**
 * `listModels()` for the OpenAI-compat transport queries the backend's real
 * `/models` endpoint (via the SDK's `models.list`) and maps `data[].id`, with a
 * graceful curated fallback on any failure. Verified offline by injecting a fake
 * client through the `createClient` seam — no real network, no keys.
 */

/** A minimal fake OpenAI client whose `models.list` returns a canned page. */
function fakeClientWith(data: Array<{ id: string }>): OpenAI {
  return {
    models: { list: async () => ({ data }) },
  } as unknown as OpenAI;
}

function throwingClient(): OpenAI {
  return {
    models: {
      list: async () => {
        throw new Error("network down");
      },
    },
  } as unknown as OpenAI;
}

describe("openai-compat — listModels", () => {
  it("parses the live /models response into this provider's own model ids", async () => {
    const curated: ModelInfo[] = [{ id: "curated-x", contextWindow: 1000, modalities: ["text"] }];
    const adapter = createOpenAICompatAdapter({
      id: "test-compat",
      apiKey: "sk-test",
      models: curated,
      createClient: () => fakeClientWith([{ id: "live-a" }, { id: "live-b" }]),
    });
    const models = await adapter.listModels!();
    expect(models.map((m) => m.id)).toEqual(["live-a", "live-b"]);
    // The live list, not the curated static catalog.
    expect(models.map((m) => m.id)).not.toContain("curated-x");
  });

  it("enriches live ids with curated metadata when ids match", async () => {
    const curated: ModelInfo[] = [
      { id: "gpt-x", contextWindow: 4242, modalities: ["text", "image"] },
    ];
    const adapter = createOpenAICompatAdapter({
      id: "test-compat",
      apiKey: "sk-test",
      models: curated,
      createClient: () => fakeClientWith([{ id: "gpt-x" }, { id: "gpt-y" }]),
    });
    const models = await adapter.listModels!();
    const gptx = models.find((m) => m.id === "gpt-x");
    expect(gptx?.contextWindow).toBe(4242);
    expect(gptx?.modalities).toEqual(["text", "image"]);
  });

  it("falls back to the curated catalog when the endpoint errors", async () => {
    const curated: ModelInfo[] = [
      { id: "fallback-1", modalities: ["text"] },
      { id: "fallback-2", modalities: ["text"] },
    ];
    const adapter = createOpenAICompatAdapter({
      id: "test-compat",
      apiKey: "sk-test",
      models: curated,
      createClient: () => throwingClient(),
    });
    const models = await adapter.listModels!();
    expect(models).toEqual(curated);
  });

  it("falls back to the curated catalog when the live list is empty", async () => {
    const curated: ModelInfo[] = [{ id: "only", modalities: ["text"] }];
    const adapter = createOpenAICompatAdapter({
      id: "test-compat",
      apiKey: "sk-test",
      models: curated,
      createClient: () => fakeClientWith([]),
    });
    expect(await adapter.listModels!()).toEqual(curated);
  });

  it("falls back to the curated catalog when no credential resolves (auth error)", async () => {
    // requiresAuth default true, no apiKey → resolveKey throws before any client.
    const adapter = createOpenAICompatAdapter({
      id: "test-compat",
      models: DEFAULT_OPENAI_MODELS,
    });
    const models = await adapter.listModels!();
    expect(models).toEqual(DEFAULT_OPENAI_MODELS);
  });

  it("caches the result briefly (a second call does not re-query)", async () => {
    let calls = 0;
    const adapter = createOpenAICompatAdapter({
      id: "test-compat",
      apiKey: "sk-test",
      models: [],
      createClient: () => ({
        models: {
          list: async () => {
            calls++;
            return { data: [{ id: "m1" }] };
          },
        },
      }) as unknown as OpenAI,
    });
    await adapter.listModels!();
    await adapter.listModels!();
    expect(calls).toBe(1);
  });

  it("the native OpenAI adapter falls back to its default catalog with no key", async () => {
    const adapter = createOpenAIAdapter();
    const models = await adapter.listModels!();
    expect(models).toEqual(DEFAULT_OPENAI_MODELS);
    expect(models.some((m) => m.id === "gpt-4o")).toBe(true);
  });
});
