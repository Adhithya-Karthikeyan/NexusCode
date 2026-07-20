import { describe, it, expect } from "vitest";
import { createModelListCache, type ModelInfo } from "@nexuscode/shared";

describe("createModelListCache", () => {
  const models: ModelInfo[] = [{ id: "a" }, { id: "b" }];

  it("caches the first result and serves it without re-loading within the TTL", async () => {
    const cache = createModelListCache(10_000);
    let calls = 0;
    const loader = async (): Promise<ModelInfo[]> => {
      calls++;
      return models;
    };
    expect(await cache.get(loader)).toEqual(models);
    expect(await cache.get(loader)).toEqual(models);
    expect(calls).toBe(1);
  });

  it("reloads after clear()", async () => {
    const cache = createModelListCache(10_000);
    let calls = 0;
    const loader = async (): Promise<ModelInfo[]> => {
      calls++;
      return models;
    };
    await cache.get(loader);
    cache.clear();
    await cache.get(loader);
    expect(calls).toBe(2);
  });

  it("reloads after the TTL expires", async () => {
    const cache = createModelListCache(0); // immediately stale
    let calls = 0;
    const loader = async (): Promise<ModelInfo[]> => {
      calls++;
      return models;
    };
    await cache.get(loader);
    await cache.get(loader);
    expect(calls).toBe(2);
  });

  it("de-duplicates concurrent loads into a single in-flight call", async () => {
    const cache = createModelListCache(10_000);
    let calls = 0;
    const loader = async (): Promise<ModelInfo[]> => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return models;
    };
    const [a, b] = await Promise.all([cache.get(loader), cache.get(loader)]);
    expect(a).toEqual(models);
    expect(b).toEqual(models);
    expect(calls).toBe(1);
  });
});
