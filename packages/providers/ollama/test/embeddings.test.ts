import { describe, it, expect } from "vitest";
import { createOllamaAdapter, ollamaCompatConfig } from "@nexuscode/provider-ollama";

/**
 * Ollama exposes an OpenAI-compatible `/v1/embeddings` endpoint, so its adapter
 * should carry the optional `embed()` method and report `embeddings: true` — all
 * verified offline (construction only, no network / SDK call).
 */

describe("ollama — embeddings capability", () => {
  it("enables the embeddings endpoint by default", async () => {
    const adapter = createOllamaAdapter();
    const caps = await adapter.capabilities();
    expect(caps.embeddings).toBe(true);
    expect(typeof adapter.embed).toBe("function");
    // Local, no vision/audio.
    expect(caps.audio ?? false).toBe(false);
  });

  it("threads a default embed model into the compat config", () => {
    const cfg = ollamaCompatConfig();
    expect(cfg.embedModel).toBe("nomic-embed-text");
  });

  it("honors a custom embed model", () => {
    const cfg = ollamaCompatConfig({ embedModel: "mxbai-embed-large" });
    expect(cfg.embedModel).toBe("mxbai-embed-large");
  });

  it("opts out of embeddings when embedModel is null", async () => {
    const adapter = createOllamaAdapter({ embedModel: null });
    const caps = await adapter.capabilities();
    expect(caps.embeddings ?? false).toBe(false);
    expect(adapter.embed).toBeUndefined();
    expect(ollamaCompatConfig({ embedModel: null }).embedModel).toBeUndefined();
  });
});
