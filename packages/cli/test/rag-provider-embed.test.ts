/**
 * Offline tests for wiring a provider's native embeddings API into @nexuscode/rag.
 * A fake adapter (no network) stands in for a real provider; the test proves
 * `createProviderEmbedder` delegates to `adapter.embed()` and that `openRagIndex`
 * honours an injected embedder so `index`/`search` can run on real provider
 * embeddings while the default stays the offline hashing embedder.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NexusConfig } from "@nexuscode/config";
import type { CallContext, ProviderAdapter } from "@nexuscode/core";
import { createProviderEmbedder, openRagIndex } from "../src/power.js";

const DIMS = 8;

/** A deterministic, network-free adapter whose only real method is `embed`. */
function fakeEmbeddingAdapter(): { adapter: ProviderAdapter; calls: number } {
  let calls = 0;
  const adapter = {
    id: "fake",
    label: "Fake",
    transport: "http-sdk",
    capabilities: async () => ({ embeddings: true }) as never,
    chat: async () => {
      throw new Error("not used");
    },
    async *stream() {
      /* not used */
    },
    async embed(texts: string[], _ctx?: CallContext): Promise<number[][]> {
      calls++;
      // A stable pseudo-vector per text: element 0 = length, rest a cheap hash.
      return texts.map((t) => {
        const v = new Array(DIMS).fill(0);
        v[0] = t.length;
        for (let i = 0; i < t.length; i++) v[1 + (t.charCodeAt(i) % (DIMS - 1))] += 1;
        return v;
      });
    },
  } as unknown as ProviderAdapter;
  return { adapter, get calls() { return calls; } };
}

describe("createProviderEmbedder", () => {
  it("wraps an adapter's embeddings API with the configured dims and id", async () => {
    const { adapter } = fakeEmbeddingAdapter();
    const embedder = createProviderEmbedder(adapter, { dims: DIMS, model: "embed-1" });
    expect(embedder.id).toBe("provider:fake:embed-1");
    expect(embedder.dims).toBe(DIMS);
    const vecs = await embedder.embed(["hello", "world!"]);
    expect(vecs).toHaveLength(2);
    expect(vecs[0]).toHaveLength(DIMS);
    expect(vecs[0]![0]).toBe(5); // "hello".length
    expect(await embedder.embed([])).toEqual([]);
  });

  it("throws when the adapter has no embeddings method", () => {
    const noEmbed = { id: "x", embed: undefined } as unknown as ProviderAdapter;
    expect(() => createProviderEmbedder(noEmbed, { dims: DIMS })).toThrow(/does not implement embeddings/);
  });

  it("rejects a count mismatch from the provider", async () => {
    const bad = {
      id: "bad",
      embed: async () => [[1, 2, 3, 4, 5, 6, 7, 8]], // 1 vector for 2 inputs
    } as unknown as ProviderAdapter;
    const embedder = createProviderEmbedder(bad, { dims: DIMS });
    await expect(embedder.embed(["a", "b"])).rejects.toThrow(/count mismatch/);
  });
});

describe("openRagIndex — injected provider embedder", () => {
  it("uses the injected embedder for index + query (real provider embeddings path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-rag-"));
    try {
      const config = NexusConfig.parse({
        rag: { dims: DIMS, storeFile: join(dir, "index.json"), embedder: "provider", embedderProvider: "fake" },
        cache: { embeddings: false },
      });
      const holder = fakeEmbeddingAdapter();
      const embedder = createProviderEmbedder(holder.adapter, { dims: DIMS });

      const index = openRagIndex(config, { cached: false, load: false, embedder });
      const chunks = await index.index([
        { id: "a", text: "the quick brown fox jumps over the lazy dog", source: "a.txt" },
        { id: "b", text: "lorem ipsum dolor sit amet consectetur", source: "b.txt" },
      ]);
      expect(chunks.length).toBeGreaterThan(0);
      expect(holder.calls).toBeGreaterThan(0); // the provider embedder was actually invoked
      expect(index.size).toBe(chunks.length);

      const results = await index.query("quick brown fox", { topK: 2 });
      expect(results.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("defaults to the offline hashing embedder when none is injected", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-rag-"));
    try {
      const config = NexusConfig.parse({ rag: { dims: DIMS, storeFile: join(dir, "index.json") }, cache: { embeddings: false } });
      const index = openRagIndex(config, { cached: false, load: false });
      const chunks = await index.index([{ id: "a", text: "hello world offline embedder", source: "a.txt" }]);
      expect(chunks.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
