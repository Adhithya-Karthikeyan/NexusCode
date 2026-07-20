import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  dispatch,
  type Engine,
  type Labeled,
  type RunContext,
} from "@nexuscode/core";
import type { StreamChunk } from "@nexuscode/shared";
import { createMockAdapter } from "@nexuscode/provider-mock";

async function setup(): Promise<{ engine: Engine; ctx: () => Promise<{ ctx: RunContext; input: Message[] }> }> {
  const reg = new ProviderRegistry();
  await reg.register(createMockAdapter());
  const engine = createEngine({ registry: reg });
  return {
    engine,
    ctx: async () => {
      const session = await engine.openSession();
      const turn = session.newTurn({ prompt: "hello world" });
      return { ctx: turn.context(), input: turn.input };
    },
  };
}

// Local alias to avoid importing the whole message surface.
type Message = { role: string; content: { type: string; text?: string }[] };

async function drain(events: AsyncIterable<Labeled<StreamChunk>>): Promise<Labeled<StreamChunk>[]> {
  const out: Labeled<StreamChunk>[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe("dispatch — single", () => {
  it("streams a labeled timeline and settles an ok outcome over the mock", async () => {
    const { engine, ctx } = await setup();
    const { ctx: runCtx, input } = await ctx();

    const handle = dispatch(
      { kind: "single", run: { adapterId: "mock", model: "mock-fast", input, idempotencyKey: "k1" } },
      runCtx,
    );

    const events = await drain(handle.events());
    const outcome = await handle.outcome();

    expect(outcome.kind).toBe("single");
    expect(outcome.winner?.status).toBe("ok");
    expect(outcome.winner?.text).toBe("[mock-fast] Echo: hello world");
    expect(outcome.winner?.finishReason).toBe("stop");

    // The labeled stream carries bus seq + reaches a terminal run-end.
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => typeof e.seq === "number")).toBe(true);
    expect(events.some((e) => e.chunk.type === "run-end")).toBe(true);
    expect(events.every((e) => e.laneIndex === 0)).toBe(true);

    await engine.dispose();
  });

  it("settles (not throws) when the target adapter is unknown", async () => {
    const { engine, ctx } = await setup();
    const { ctx: runCtx, input } = await ctx();

    const handle = dispatch(
      { kind: "single", run: { adapterId: "ghost", model: "x", input, idempotencyKey: "k2" } },
      runCtx,
    );
    await drain(handle.events());
    const outcome = await handle.outcome();

    expect(outcome.winner?.status).toBe("error");
    expect(outcome.partial).toBe(true);
    await engine.dispose();
  });
});

describe("dispatch — compare", () => {
  it("runs two lanes to completion and settles both", async () => {
    const { engine, ctx } = await setup();
    const { ctx: runCtx, input } = await ctx();

    const handle = dispatch(
      {
        kind: "compare",
        runs: [
          { adapterId: "mock", model: "mock-fast", input, idempotencyKey: "a" },
          { adapterId: "mock", model: "mock-smart", input, idempotencyKey: "b" },
        ],
      },
      runCtx,
    );

    const events = await drain(handle.events());
    const outcome = await handle.outcome();

    expect(outcome.kind).toBe("compare");
    expect(outcome.runs).toHaveLength(2);
    expect(outcome.partial).toBe(false);
    expect(outcome.runs.every((r) => r.status === "ok")).toBe(true);
    expect(outcome.runs.map((r) => r.model).sort()).toEqual(["mock-fast", "mock-smart"]);

    // Both lanes appear in the merged timeline.
    const lanes = new Set(events.map((e) => e.laneIndex));
    expect(lanes.has(0)).toBe(true);
    expect(lanes.has(1)).toBe(true);

    // Aggregate usage is summed across lanes.
    expect(outcome.usage.outputTokens).toBeGreaterThan(0);

    await engine.dispose();
  });

  it("settles partial when one lane fails and the other succeeds", async () => {
    const { engine, ctx } = await setup();
    const { ctx: runCtx, input } = await ctx();

    const handle = dispatch(
      {
        kind: "compare",
        runs: [
          { adapterId: "mock", model: "mock-fast", input, idempotencyKey: "a" },
          { adapterId: "ghost", model: "x", input, idempotencyKey: "b" },
        ],
      },
      runCtx,
    );
    await drain(handle.events());
    const outcome = await handle.outcome();

    expect(outcome.partial).toBe(true);
    const statuses = outcome.runs.map((r) => r.status).sort();
    expect(statuses).toEqual(["error", "ok"]);
    await engine.dispose();
  });
});
