/**
 * Mutex unit tests — the runSync startup-only guard and tail-chain liveness.
 *
 * The guard: `runSync` is the startup-only fast path (WAL recovery before any
 * live writer). Once a `run` has been enqueued on THIS mutex, `runSync` must
 * refuse — it would jump the async queue and risk hitting an open transaction.
 * Recovery paths use a fresh mutex, so they never trip the guard.
 */
import { describe, it, expect } from "vitest";
import { createMutex } from "../src/mutex.js";

describe("Mutex", () => {
  it("runSync executes on a fresh mutex (pure startup path)", () => {
    const m = createMutex();
    expect(m.runSync(() => 42)).toBe(42);
  });

  it("runSync refuses once a live async writer has been enqueued (queue-jump guard)", async () => {
    const m = createMutex();
    await m.run(() => Promise.resolve(1));
    expect(() => m.runSync(() => 1)).toThrow(/live async writer/);
  });

  it("runSync refuses even if the live run rejected — the guard is structural, not state-dependent", async () => {
    const m = createMutex();
    await expect(m.run(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(() => m.runSync(() => 1)).toThrow(/live async writer/);
  });

  it("a rejected run does not starve a later run (tail-chain liveness)", async () => {
    const m = createMutex();
    await expect(m.run(() => Promise.reject(new Error("first-fail")))).rejects.toThrow("first-fail");
    const res = await m.run(() => Promise.resolve("second-ok"));
    expect(res).toBe("second-ok");
  });

  it("runs serialize: the second runs only after the first settles", async () => {
    const m = createMutex();
    const order: string[] = [];
    const p1 = m.run(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            order.push("a");
            resolve("a");
          }, 20);
        }),
    );
    const p2 = m.run(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => {
            order.push("b");
            resolve("b");
          }, 5);
        }),
    );
    await Promise.all([p1, p2]);
    expect(order).toEqual(["a", "b"]);
  });
});