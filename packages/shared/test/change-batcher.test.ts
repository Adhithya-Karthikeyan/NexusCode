import { describe, it, expect, vi, afterEach } from "vitest";
import { ChangeBatcher } from "../src/change-batcher.js";

/**
 * ChangeBatcher (system-spec §23: incremental updates · watch mode). A burst of
 * raw change events for one logical edit must coalesce into a single flush after
 * a quiet window. Driven with fake timers so it is deterministic and sleepless.
 */
describe("ChangeBatcher — debounced change coalescing", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst into ONE flush with the distinct paths after the quiet window", async () => {
    vi.useFakeTimers();
    const flushes: string[][] = [];
    const batcher = new ChangeBatcher({ delayMs: 100, onFlush: (paths) => void flushes.push(paths) });

    batcher.notify("a.ts");
    batcher.notify("b.ts");
    batcher.notify("a.ts"); // duplicate collapses

    // Before the window elapses nothing has fired.
    expect(flushes).toHaveLength(0);
    expect(batcher.pending).toEqual(["a.ts", "b.ts"]);

    await vi.advanceTimersByTimeAsync(100);
    expect(flushes).toEqual([["a.ts", "b.ts"]]);
  });

  it("resets the window on each notify (debounce, not throttle)", async () => {
    vi.useFakeTimers();
    let count = 0;
    const batcher = new ChangeBatcher({ delayMs: 100, onFlush: () => void count++ });

    batcher.notify("x");
    await vi.advanceTimersByTimeAsync(60);
    batcher.notify("y"); // re-arms; still nothing yet
    await vi.advanceTimersByTimeAsync(60);
    expect(count).toBe(0);
    await vi.advanceTimersByTimeAsync(40);
    expect(count).toBe(1);
  });

  it("flush() forces an immediate flush and awaits onFlush", async () => {
    const seen: string[][] = [];
    const batcher = new ChangeBatcher({
      delayMs: 10_000,
      onFlush: async (paths) => {
        seen.push(paths);
      },
    });
    batcher.notify("now.ts");
    await batcher.flush();
    expect(seen).toEqual([["now.ts"]]);
  });

  it("close() cancels a pending flush and ignores further notifications", async () => {
    vi.useFakeTimers();
    let count = 0;
    const batcher = new ChangeBatcher({ delayMs: 50, onFlush: () => void count++ });
    batcher.notify("a");
    batcher.close();
    batcher.notify("b");
    await vi.advanceTimersByTimeAsync(100);
    expect(count).toBe(0);
    expect(batcher.pending).toEqual([]);
  });
});
