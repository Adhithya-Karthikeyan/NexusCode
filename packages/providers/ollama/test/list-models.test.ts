import { describe, it, expect } from "vitest";
import { createOllamaAdapter, ollamaTagsUrl } from "@nexuscode/provider-ollama";

/**
 * `listModels()` on the Ollama adapter hits the daemon's native `GET /api/tags`
 * and maps `models[].name`. A fake `fetch` verifies the parse offline; a daemon
 * that is down (fetch throws / non-200) yields an EMPTY list — a local daemon
 * genuinely has no models when it is not running, so there is no invented
 * fallback catalog.
 */

function tagsFetch(names: string[], capture?: { url?: string }) {
  return (async (url: string | URL | Request) => {
    if (capture) capture.url = String(url);
    return new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("ollama — listModels", () => {
  it("derives the /api/tags URL from the OpenAI-compat base URL", () => {
    expect(ollamaTagsUrl("http://localhost:11434/v1")).toBe("http://localhost:11434/api/tags");
    expect(ollamaTagsUrl("http://host:1234/v1/")).toBe("http://host:1234/api/tags");
  });

  it("lists the models the daemon reports as pulled", async () => {
    const capture: { url?: string } = {};
    const adapter = createOllamaAdapter({
      fetchImpl: tagsFetch(["llama3.2:latest", "qwen2.5-coder:7b"], capture),
    });
    const models = await adapter.listModels!();
    expect(models.map((m) => m.id)).toEqual(["llama3.2:latest", "qwen2.5-coder:7b"]);
    expect(capture.url).toBe("http://localhost:11434/api/tags");
  });

  it("returns an empty list when the daemon is down (fetch throws)", async () => {
    const adapter = createOllamaAdapter({
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    expect(await adapter.listModels!()).toEqual([]);
  });

  it("returns an empty list on a non-200 response", async () => {
    const adapter = createOllamaAdapter({
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    expect(await adapter.listModels!()).toEqual([]);
  });
});
