/**
 * Backend tests: MemoryCache LRU eviction + TTL expiry, and DiskCache
 * persistence round-trip + TTL + safe perms. All use injectable clocks / temp
 * dirs — no wall-clock or network dependence.
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskCache } from "../src/backends/disk.js";
import { MemoryCache } from "../src/backends/memory.js";

/** A controllable clock. */
function clockAt(start: number): { now: () => number; set: (t: number) => void } {
  let t = start;
  return { now: () => t, set: (v: number) => (t = v) };
}

describe("MemoryCache — LRU eviction", () => {
  it("evicts the least-recently-used entry past capacity", async () => {
    const c = new MemoryCache<number>({ maxEntries: 2 });
    await c.set("a", 1);
    await c.set("b", 2);
    // Touch "a" so "b" becomes least-recently-used.
    expect(await c.get("a")).toBe(1);
    await c.set("c", 3); // capacity exceeded → evict LRU ("b")

    expect(await c.get("b")).toBeUndefined();
    expect(await c.get("a")).toBe(1);
    expect(await c.get("c")).toBe(3);
    expect(c.metrics().evictions).toBe(1);
  });

  it("overwriting a key refreshes its recency", async () => {
    const c = new MemoryCache<number>({ maxEntries: 2 });
    await c.set("a", 1);
    await c.set("b", 2);
    await c.set("a", 10); // a is now most-recent
    await c.set("c", 3); // evict LRU ("b")
    expect(await c.get("b")).toBeUndefined();
    expect(await c.get("a")).toBe(10);
  });
});

describe("MemoryCache — TTL expiry", () => {
  it("expires an entry once its TTL elapses", async () => {
    const clock = clockAt(1_000);
    const c = new MemoryCache<string>({ now: clock.now });
    await c.set("k", "v", { ttlMs: 100 });

    clock.set(1_099);
    expect(await c.get("k")).toBe("v"); // still live

    clock.set(1_100);
    expect(await c.get("k")).toBeUndefined(); // expired at exactly ttl
    expect(c.metrics().expirations).toBe(1);
    expect(await c.has("k")).toBe(false);
  });

  it("default TTL applies when a write omits ttlMs", async () => {
    const clock = clockAt(0);
    const c = new MemoryCache<number>({ defaultTtlMs: 50, now: clock.now });
    await c.set("k", 7);
    clock.set(60);
    expect(await c.get("k")).toBeUndefined();
  });

  it("no TTL means the entry never expires", async () => {
    const clock = clockAt(0);
    const c = new MemoryCache<number>({ now: clock.now });
    await c.set("k", 7);
    clock.set(10_000_000);
    expect(await c.get("k")).toBe(7);
  });
});

describe("DiskCache — persistence round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexus-cache-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("survives a fresh cache instance over the same dir", async () => {
    const a = new DiskCache<{ n: number }>({ dir, namespace: "resp" });
    await a.set("key-1", { n: 42 });

    // A brand-new instance (simulating a process restart) reads it back.
    const b = new DiskCache<{ n: number }>({ dir, namespace: "resp" });
    expect(await b.get("key-1")).toEqual({ n: 42 });
    expect(await b.has("key-1")).toBe(true);
    expect(await b.keys()).toEqual(["key-1"]);
  });

  it("writes cache files with 0600 perms", async () => {
    const c = new DiskCache<string>({ dir, namespace: "secure" });
    await c.set("k", "sensitive-prompt");
    const files = await c.keys();
    expect(files).toContain("k");
    // Inspect the actual on-disk file mode (POSIX only).
    if (process.platform !== "win32") {
      const nsDir = join(dir, "secure");
      const { readdirSync } = await import("node:fs");
      const [file] = readdirSync(nsDir).filter((f) => f.endsWith(".json"));
      const mode = statSync(join(nsDir, file!)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it("honours TTL on disk", async () => {
    const clock = clockAt(1_000);
    const c = new DiskCache<number>({ dir, now: clock.now });
    await c.set("k", 5, { ttlMs: 200 });
    clock.set(1_150);
    expect(await c.get("k")).toBe(5);
    clock.set(1_200);
    expect(await c.get("k")).toBeUndefined();
    expect(c.metrics().expirations).toBe(1);
  });

  it("delete and clear remove entries", async () => {
    const c = new DiskCache<number>({ dir, namespace: "x" });
    await c.set("a", 1);
    await c.set("b", 2);
    expect(await c.delete("a")).toBe(true);
    expect(await c.get("a")).toBeUndefined();
    expect(await c.size()).toBe(1);
    await c.clear();
    expect(await c.size()).toBe(0);
  });

  it("prunes oldest entries past maxEntries", async () => {
    const clock = clockAt(0);
    const c = new DiskCache<number>({ dir, namespace: "cap", maxEntries: 2, now: clock.now });
    await c.set("a", 1);
    clock.set(1);
    await c.set("b", 2);
    clock.set(2);
    await c.set("c", 3); // oldest ("a") pruned
    const keys = (await c.keys()).sort();
    expect(keys).toEqual(["b", "c"]);
    expect(c.metrics().evictions).toBe(1);
  });
});
