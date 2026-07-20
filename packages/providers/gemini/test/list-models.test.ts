import { describe, it, expect } from "vitest";
import {
  createGeminiAdapter,
  DEFAULT_GEMINI_MODELS,
  type GeminiClientLike,
} from "@nexuscode/provider-gemini";

/**
 * `listModels()` on the native Gemini adapter uses the SDK's `models.list()` and
 * strips the `models/` namespace prefix from each `name`. A fake client (injected
 * through the `createClient` seam) verifies the parse offline; a client with no
 * `list`, or no resolvable key, degrades to the curated Gemini catalog.
 */

const modelMap = { flash: "gemini-2.0-flash" };

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

describe("gemini — listModels", () => {
  it("lists this provider's own models from models.list(), stripping the namespace", async () => {
    const adapter = createGeminiAdapter(
      {
        modelMap,
        createClient: () => fakeClient(["models/gemini-2.5-pro", "models/gemini-2.0-flash"]),
      },
      () => "gm-key",
    );
    const models = await adapter.listModels!();
    expect(models.map((m) => m.id)).toEqual(["gemini-2.5-pro", "gemini-2.0-flash"]);
  });

  it("falls back to the curated catalog when the client exposes no list method", async () => {
    const adapter = createGeminiAdapter(
      {
        modelMap,
        createClient: () =>
          ({ models: { generateContentStream: (async () => (async function* () {})()) as never } }) as GeminiClientLike,
      },
      () => "gm-key",
    );
    expect(await adapter.listModels!()).toEqual(DEFAULT_GEMINI_MODELS);
  });

  it("falls back to the curated catalog when list() throws", async () => {
    const adapter = createGeminiAdapter(
      {
        modelMap,
        createClient: () =>
          ({
            models: {
              generateContentStream: (async () => (async function* () {})()) as never,
              list: async () => {
                throw new Error("offline");
              },
            },
          }) as GeminiClientLike,
      },
      () => "gm-key",
    );
    expect(await adapter.listModels!()).toEqual(DEFAULT_GEMINI_MODELS);
  });

  it("falls back to the curated catalog when no API key resolves", async () => {
    const prev = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const adapter = createGeminiAdapter({ modelMap }, () => "");
      expect(await adapter.listModels!()).toEqual(DEFAULT_GEMINI_MODELS);
    } finally {
      if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
    }
  });
});
