/**
 * Tests for `AsyncQueue` (queue.ts) — the single-producer/single-consumer
 * queue backing `AgentHandle.events()`. It must mirror the kernel's own
 * `AsyncQueue` (packages/core/src/orchestrate/orchestrator.ts): `fail()`
 * rejects any already-parked waiter, and post-fail iteration surfaces the
 * stored error rather than a clean end-of-stream.
 */
import { describe, it, expect } from "vitest";
import { AsyncQueue } from "../src/queue.js";

describe("AsyncQueue — push/next round-trip", () => {
  it("delivers a pushed value to a subsequent next() call", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(42);
    const it0 = queue[Symbol.asyncIterator]();
    const result = await it0.next();
    expect(result).toEqual({ value: 42, done: false });
  });

  it("delivers a pushed value to an already-parked next() call", async () => {
    const queue = new AsyncQueue<string>();
    const it0 = queue[Symbol.asyncIterator]();
    const pending = it0.next();
    queue.push("hello");
    await expect(pending).resolves.toEqual({ value: "hello", done: false });
  });
});

describe("AsyncQueue — close()", () => {
  it("resolves an already-parked waiter with done:true", async () => {
    const queue = new AsyncQueue<number>();
    const it0 = queue[Symbol.asyncIterator]();
    const pending = it0.next();
    queue.close();
    await expect(pending).resolves.toEqual({ value: undefined, done: true });
  });

  it("resolves a subsequent next() call with done:true once closed", async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    const it0 = queue[Symbol.asyncIterator]();
    await expect(it0.next()).resolves.toEqual({ value: undefined, done: true });
  });
});

describe("AsyncQueue — fail() (core-F4 regression)", () => {
  it("REJECTS an already-parked waiter with the error, not a clean done:true", async () => {
    const queue = new AsyncQueue<number>();
    const it0 = queue[Symbol.asyncIterator]();
    const pending = it0.next();
    const err = new Error("pump exploded");
    queue.fail(err);
    await expect(pending).rejects.toBe(err);
  });

  it("rejects every subsequent next() call after fail(), not just the first", async () => {
    const queue = new AsyncQueue<number>();
    const err = new Error("boom");
    queue.fail(err);
    const it0 = queue[Symbol.asyncIterator]();
    await expect(it0.next()).rejects.toBe(err);
    await expect(it0.next()).rejects.toBe(err);
  });

  it("a consumer iterating with for-await sees the failure thrown, not a truncated clean stream", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    const err = new Error("adapter died mid-stream");
    queue.fail(err);

    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const v of queue) seen.push(v);
      })(),
    ).rejects.toBe(err);
    // The values queued before the failure are still delivered first.
    expect(seen).toEqual([1, 2]);
  });
});

describe("AsyncQueue — close-then-push is inert", () => {
  it("drops a push after close() instead of reviving the stream", async () => {
    const queue = new AsyncQueue<number>();
    queue.close();
    queue.push(99);
    const it0 = queue[Symbol.asyncIterator]();
    await expect(it0.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("drops a push after fail() instead of surfacing a value before the error", async () => {
    const queue = new AsyncQueue<number>();
    const err = new Error("late push");
    queue.fail(err);
    queue.push(99);
    const it0 = queue[Symbol.asyncIterator]();
    await expect(it0.next()).rejects.toBe(err);
  });
});
