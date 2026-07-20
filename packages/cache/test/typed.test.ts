/**
 * Typed-cache tests: ResponseCache returns a cached result on an identical
 * request and books savings; EmbeddingCache dedupes vectors; FileCache
 * invalidates on a fingerprint change; savings accounting totals correctly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChatRequest, Pricing } from "@nexuscode/shared";
import { MemoryCache } from "../src/backends/memory.js";
import { DiskCache } from "../src/backends/disk.js";
import { EmbeddingCache } from "../src/typed/embedding.js";
import { FileCache } from "../src/typed/file.js";
import type { FileFingerprint } from "../src/typed/file.js";
import { ResponseCache, signatureOf } from "../src/typed/response.js";
import type { CachedResponse } from "../src/typed/response.js";

function req(model: string, text: string, temperature = 0): ChatRequest {
  return {
    model,
    messages: [{ role: "user", content: [{ type: "text", text }] }],
    temperature,
  };
}

describe("ResponseCache", () => {
  it("returns the cached result for an identical request", async () => {
    const cache = new ResponseCache({ backend: new MemoryCache<CachedResponse>() });
    const request = req("gpt-x", "hello");
    expect(await cache.get(request)).toBeUndefined(); // cold miss

    const stored: CachedResponse = {
      text: "hi there",
      usage: { inputTokens: 10, outputTokens: 5 },
      model: "gpt-x",
    };
    await cache.set(request, stored);

    // An independently-constructed but structurally-identical request hits.
    const hit = await cache.get(req("gpt-x", "hello"));
    expect(hit).toEqual(stored);
  });

  it("keys on request content — different messages miss", async () => {
    const cache = new ResponseCache({ backend: new MemoryCache<CachedResponse>() });
    await cache.set(req("m", "a"), { text: "A", usage: { inputTokens: 1, outputTokens: 1 }, model: "m" });
    expect(await cache.get(req("m", "b"))).toBeUndefined();
    expect(await cache.get(req("m", "a", 0.7))).toBeUndefined(); // temperature is part of the key
  });

  it("is order-insensitive across equivalent signatures", async () => {
    const cache = new ResponseCache({ backend: new MemoryCache<CachedResponse>() });
    const sigA = signatureOf({ ...req("m", "x"), maxTokens: 100, temperature: 0 });
    const sigB = signatureOf({ ...req("m", "x"), temperature: 0, maxTokens: 100 });
    expect(cache.key(sigA)).toBe(cache.key(sigB));
  });

  it("accounts for tokens and cost saved on a hit", async () => {
    const pricing: Record<string, Pricing> = {
      "gpt-x": { inputPerMTok: 3, outputPerMTok: 15 },
    };
    const cache = new ResponseCache({ backend: new MemoryCache<CachedResponse>(), pricing });
    const request = req("gpt-x", "compute");
    await cache.set(request, {
      text: "result",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      model: "gpt-x",
    });

    await cache.get(request); // hit #1
    await cache.get(request); // hit #2
    await cache.get(req("gpt-x", "other")); // miss

    const stats = await cache.stats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.writes).toBe(1);
    expect(stats.savedInputTokens).toBe(2_000_000);
    expect(stats.savedOutputTokens).toBe(2_000_000);
    expect(stats.savedTokens).toBe(4_000_000);
    // (1M * $3 + 1M * $15) / 1M = $18 per hit, ×2 = $36.
    expect(stats.estimatedCostSavedUsd).toBeCloseTo(36, 6);
    expect(stats.hitRate).toBeCloseTo(2 / 3, 6);
  });

  it("round-trips through a disk backend", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nexus-resp-"));
    try {
      const backend = new DiskCache<CachedResponse>({ dir, namespace: "resp" });
      const cache = new ResponseCache({ backend });
      const request = req("m", "persist me");
      await cache.set(request, { text: "ok", usage: { inputTokens: 2, outputTokens: 2 }, model: "m" });

      const fresh = new ResponseCache({ backend: new DiskCache<CachedResponse>({ dir, namespace: "resp" }) });
      expect((await fresh.get(request))?.text).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("EmbeddingCache", () => {
  it("returns cached vectors and dedupes re-embeds", async () => {
    const cache = new EmbeddingCache({ backend: new MemoryCache<number[]>() });
    expect(await cache.get("embed-1", "chunk")).toBeUndefined();
    await cache.set("embed-1", "chunk", [0.1, 0.2, 0.3]);
    expect(await cache.get("embed-1", "chunk")).toEqual([0.1, 0.2, 0.3]);

    const many = await cache.getMany("embed-1", ["chunk", "missing"]);
    expect(many[0]).toEqual([0.1, 0.2, 0.3]);
    expect(many[1]).toBeUndefined();
  });

  it("books saved embedding tokens on hits", async () => {
    const cache = new EmbeddingCache({
      backend: new MemoryCache<number[]>(),
      estimateTokens: (t) => t.length, // 1 token / char for a clean assertion
    });
    await cache.set("m", "abcd", [1]);
    await cache.get("m", "abcd");
    const stats = await cache.stats();
    expect(stats.savedInputTokens).toBe(4);
    expect(stats.savedOutputTokens).toBe(0);
  });
});

describe("FileCache", () => {
  const fp = (mtimeMs: number, size: number): FileFingerprint => ({ mtimeMs, size });

  it("serves a cached derivation while the file is unchanged", async () => {
    const cache = new FileCache<string[]>({ backend: new MemoryCache() });
    const path = "/repo/src/a.ts";
    expect(await cache.get(path, fp(100, 20))).toBeUndefined(); // cold
    await cache.set(path, fp(100, 20), ["symbolA", "symbolB"]);
    expect(await cache.get(path, fp(100, 20))).toEqual(["symbolA", "symbolB"]);
  });

  it("invalidates when the fingerprint changes", async () => {
    const cache = new FileCache<string[]>({ backend: new MemoryCache() });
    const path = "/repo/src/a.ts";
    await cache.set(path, fp(100, 20), ["old"]);
    // File edited: mtime advanced → stale → miss (and the stale entry is dropped).
    expect(await cache.get(path, fp(200, 25))).toBeUndefined();
    // Even reverting to the old fingerprint won't resurrect the evicted entry.
    expect(await cache.get(path, fp(100, 20))).toBeUndefined();

    const stats = await cache.stats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(2);
  });
});
