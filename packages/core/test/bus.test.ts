import { describe, it, expect } from "vitest";
import { InProcessBus, createBus, mergeAsyncIterables, type Labeled } from "@nexuscode/core";
import type { StreamChunk } from "@nexuscode/shared";

function textDelta(runId: string, text: string): StreamChunk {
  return { type: "text-delta", runId, text };
}

async function* gen(runId: string, texts: string[]): AsyncIterable<StreamChunk> {
  for (const t of texts) yield textDelta(runId, t);
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

describe("InProcessBus.publish", () => {
  it("stamps a monotonic seq and the lane label on every chunk", async () => {
    const bus = new InProcessBus();
    const labeled = await collect(bus.publish(gen("r1", ["a", "b", "c"]), { runId: "r1", laneIndex: 0 }));
    expect(labeled.map((l) => l.seq)).toEqual([0, 1, 2]);
    expect(labeled.every((l) => l.runId === "r1" && l.laneIndex === 0)).toBe(true);
  });

  it("defaults laneIndex to 0", async () => {
    const bus = new InProcessBus();
    const labeled = await collect(bus.publish(gen("r1", ["x"]), { runId: "r1" }));
    expect(labeled[0]?.laneIndex).toBe(0);
  });
});

describe("InProcessBus.merge", () => {
  it("assigns a single monotonic seq across lanes (unique + contiguous)", async () => {
    const bus = new InProcessBus();
    const laneA = bus.publish(gen("a", ["a1", "a2", "a3"]), { runId: "a", laneIndex: 0 });
    const laneB = bus.publish(gen("b", ["b1", "b2"]), { runId: "b", laneIndex: 1 });
    const merged = await collect(bus.merge([laneA, laneB]));

    expect(merged).toHaveLength(5);
    const seqs = merged.map((l) => l.seq).sort((x, y) => x - y);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
    expect(new Set(seqs).size).toBe(5);
  });

  it("preserves per-lane emission order in the merged stream", async () => {
    const bus = new InProcessBus();
    const laneA = bus.publish(gen("a", ["a1", "a2", "a3"]), { runId: "a", laneIndex: 0 });
    const laneB = bus.publish(gen("b", ["b1", "b2"]), { runId: "b", laneIndex: 1 });
    const merged = await collect(bus.merge([laneA, laneB]));

    const textsFor = (lane: number): string[] =>
      merged
        .filter((l: Labeled<StreamChunk>) => l.laneIndex === lane)
        .map((l) => (l.chunk.type === "text-delta" ? l.chunk.text : ""));

    expect(textsFor(0)).toEqual(["a1", "a2", "a3"]);
    expect(textsFor(1)).toEqual(["b1", "b2"]);
  });

  it("within a lane, seq is strictly increasing", async () => {
    const bus = new InProcessBus();
    const laneA = bus.publish(gen("a", ["a1", "a2", "a3"]), { runId: "a", laneIndex: 0 });
    const merged = await collect(bus.merge([laneA]));
    const laneSeqs = merged.map((l) => l.seq);
    for (let i = 1; i < laneSeqs.length; i++) {
      expect(laneSeqs[i]!).toBeGreaterThan(laneSeqs[i - 1]!);
    }
  });
});

describe("mergeAsyncIterables", () => {
  it("drains every source exactly once", async () => {
    const merged = await collect(
      mergeAsyncIterables<number>([
        (async function* () {
          yield 1;
          yield 2;
        })(),
        (async function* () {
          yield 3;
        })(),
      ]),
    );
    expect(merged.slice().sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });
});

describe("createBus", () => {
  it("returns an independent bus with its own seq counter", async () => {
    const b1 = createBus();
    const b2 = createBus();
    const l1 = await collect(b1.publish(gen("r", ["x", "y"]), { runId: "r", laneIndex: 0 }));
    const l2 = await collect(b2.publish(gen("r", ["x", "y"]), { runId: "r", laneIndex: 0 }));
    expect(l1.map((l) => l.seq)).toEqual([0, 1]);
    expect(l2.map((l) => l.seq)).toEqual([0, 1]);
  });
});
