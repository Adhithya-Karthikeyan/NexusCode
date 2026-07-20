import { describe, it, expect } from "vitest";
import { createVertexAdapter } from "@nexuscode/provider-vertex";
import type { GeminiClientLike } from "@nexuscode/provider-gemini";

/**
 * `listModels()` on the Vertex adapter reuses the shared Gemini `models.list()`
 * discovery. A fake client verifies the parse offline; when the client cannot
 * list (no method / error / no ADC), it degrades to the config-driven Vertex
 * catalog — its OWN models, never the global catalog.
 */

const modelMap = { gemini: "gemini-2.0-flash", pro: "gemini-2.5-pro" };

function fakeClient(names: string[]): GeminiClientLike {
  return {
    models: {
      generateContentStream: (async () => (async function* () {})()) as never,
      list: async () =>
        (async function* () {
          for (const name of names) yield { name };
        })(),
    },
  };
}

describe("vertex — listModels", () => {
  it("lists models from the SDK, stripping the namespace prefix", async () => {
    const adapter = createVertexAdapter({
      modelMap,
      createClient: () => fakeClient(["models/gemini-2.5-pro", "models/gemini-1.5-pro"]),
    });
    const ids = (await adapter.listModels!()).map((m) => m.id);
    expect(ids).toEqual(["gemini-2.5-pro", "gemini-1.5-pro"]);
  });

  it("falls back to the config-driven catalog when the client cannot list", async () => {
    const adapter = createVertexAdapter({
      modelMap,
      createClient: () =>
        ({ models: { generateContentStream: (async () => (async function* () {})()) as never } }) as GeminiClientLike,
    });
    const ids = (await adapter.listModels!()).map((m) => m.id).sort();
    // The modelMap's native ids, deduped.
    expect(ids).toEqual(["gemini-2.0-flash", "gemini-2.5-pro"].sort());
  });
});
