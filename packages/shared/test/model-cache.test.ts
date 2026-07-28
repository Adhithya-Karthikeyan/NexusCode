import { describe, it, expect } from "vitest";
import { createModelListCache, type ModelInfo, type ModelListResult } from "@nexuscode/shared";

describe("createModelListCache", () => {
  const models: ModelInfo[] = [{ id: "a" }, { id: "b" }];
  const provider: ModelListResult = { models, source: "provider" };
  const fallback: ModelListResult = { models, source: "fallback" };

  it("caches the first result and serves it without re-loading within the TTL", async () => {
    const cache = createModelListCache(10_000);
    let calls = 0;
    const loader = async (): Promise<ModelListResult> => {
      calls++;
      return provider;
    };
    expect(await cache.get(loader)).toEqual(provider);
    expect(await cache.get(loader)).toEqual(provider);
    expect(calls).toBe(1);
  });

  it("caches the source alongside the models — a hit never separates the two", async () => {
    const cache = createModelListCache(10_000);
    const loader = async (): Promise<ModelListResult> => fallback;
    const first = await cache.get(loader);
    const second = await cache.get(loader);
    expect(first.source).toBe("fallback");
    expect(second.source).toBe("fallback");
    expect(second).toEqual(first);
  });

  it("reloads after clear()", async () => {
    const cache = createModelListCache(10_000);
    let calls = 0;
    const loader = async (): Promise<ModelListResult> => {
      calls++;
      return provider;
    };
    await cache.get(loader);
    cache.clear();
    await cache.get(loader);
    expect(calls).toBe(2);
  });

  it("reloads after the TTL expires", async () => {
    const cache = createModelListCache(0); // immediately stale
    let calls = 0;
    const loader = async (): Promise<ModelListResult> => {
      calls++;
      return provider;
    };
    await cache.get(loader);
    await cache.get(loader);
    expect(calls).toBe(2);
  });

  it("de-duplicates concurrent loads into a single in-flight call", async () => {
    const cache = createModelListCache(10_000);
    let calls = 0;
    const loader = async (): Promise<ModelListResult> => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return provider;
    };
    const [a, b] = await Promise.all([cache.get(loader), cache.get(loader)]);
    expect(a).toEqual(provider);
    expect(b).toEqual(provider);
    expect(calls).toBe(1);
  });
});
