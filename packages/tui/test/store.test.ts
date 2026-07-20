import { describe, expect, it, vi } from "vitest";
import {
  createEventStore,
  initialViewState,
  reduceEvent,
  reduceEvents,
  selectActiveHealth,
  selectAllFinalizedTurns,
  selectContext,
  selectCost,
  selectFailover,
  selectFinalizedTurns,
  selectLiveTurn,
  selectMessageCount,
  selectModel,
  selectProviderHealth,
  selectRunningToolCount,
  selectStreaming,
  selectToolActivity,
  type UiEvent,
} from "../src/index.js";

const session: UiEvent = { t: "session", id: "run1", provider: "anthropic", model: "Opus 4.8", ts: 1 };

describe("event-log reducer", () => {
  it("is pure — never mutates its input", () => {
    const before = initialViewState;
    const after = reduceEvent(before, session, 1);
    expect(after).not.toBe(before);
    expect(before.session).toBeNull();
    expect(before.eventCount).toBe(0);
    expect(after.session?.model).toBe("Opus 4.8");
  });

  it("accumulates text deltas into a live turn, finalized on done", () => {
    const v = reduceEvents([
      session,
      { t: "text", lane: "main", delta: "Hello " },
      { t: "text", lane: "main", delta: "world" },
    ]);
    expect(selectLiveTurn(v)?.text).toBe("Hello world");
    expect(selectStreaming(v)).toBe(true);
    expect(selectFinalizedTurns(v)).toHaveLength(0);

    const done = reduceEvent(v, { t: "done", lane: "main", finishReason: "stop" }, 2);
    expect(selectLiveTurn(done)).toBeNull();
    expect(selectStreaming(done)).toBe(false);
    expect(selectFinalizedTurns(done)).toHaveLength(1);
    expect(selectFinalizedTurns(done)[0]?.text).toBe("Hello world");
    expect(selectMessageCount(done)).toBe(1);
  });

  it("tracks tool activity lifecycle", () => {
    const v = reduceEvents([
      session,
      { t: "tool_call", lane: "main", id: "t1", name: "read_file", args: { path: "a.ts" } },
      { t: "tool_call", lane: "main", id: "t2", name: "grep", args: {} },
      { t: "tool_result", lane: "main", id: "t1", ok: true, result: "ok" },
    ]);
    const tools = selectToolActivity(v);
    expect(tools).toHaveLength(2);
    expect(tools.find((t) => t.id === "t1")?.status).toBe("ok");
    expect(tools.find((t) => t.id === "t2")?.status).toBe("running");
    expect(selectRunningToolCount(v)).toBe(1);
  });

  it("aggregates usage/cost and sizes the context gauge from the last request", () => {
    const v = reduceEvents([
      session,
      { t: "usage", lane: "main", inputTokens: 1000, outputTokens: 200, costUsd: 0.1 },
      { t: "usage", lane: "main", inputTokens: 84000, outputTokens: 200, costUsd: 0.31 },
    ]);
    expect(selectCost(v)).toEqual({ sessionUsd: expect.closeTo(0.41, 5), runUsd: 0.31 });
    const ctx = selectContext(v, 200000);
    expect(ctx.used).toBe(84200);
    expect(ctx.max).toBe(200000);
    expect(ctx.pct).toBeCloseTo(0.421, 3);
  });

  it("derives provider health passively from outcomes", () => {
    const ok = reduceEvents([session, { t: "done", lane: "main", finishReason: "stop" }]);
    expect(selectActiveHealth(ok)?.status).toBe("ok");

    const err = reduceEvents([
      session,
      { t: "error", lane: "main", code: "rate_limit", message: "429", retryable: true },
    ]);
    expect(selectActiveHealth(err)?.status).toBe("degraded");

    const down = reduceEvents([
      session,
      { t: "error", lane: "main", code: "auth", message: "401", retryable: false },
    ]);
    expect(selectActiveHealth(down)?.status).toBe("down");
    expect(selectProviderHealth(down)).toHaveLength(1);
  });

  it("reports the served model and no failover for a healthy single provider", () => {
    const v = reduceEvents([session, { t: "done", lane: "main", finishReason: "stop" }]);
    expect(selectModel(v)).toEqual({ model: "Opus 4.8", provider: "anthropic" });
    expect(selectFailover(v)).toBe(false);
  });

  it("keeps per-lane turns for compare/race fan-out", () => {
    const v = reduceEvents([
      session,
      { t: "text", lane: "a", delta: "from a" },
      { t: "done", lane: "a", finishReason: "stop" },
      { t: "text", lane: "b", delta: "from b" },
      { t: "done", lane: "b", finishReason: "stop" },
    ]);
    expect(selectFinalizedTurns(v, "a")[0]?.text).toBe("from a");
    expect(selectFinalizedTurns(v, "b")[0]?.text).toBe("from b");
    expect(selectAllFinalizedTurns(v)).toHaveLength(2);
  });

  it("keys fan-out (compare/race) provider health by lane, not the last session", () => {
    // Two lanes, each its own adapter (the lane key IS the adapter id in
    // fan-out) — a `session` overwritten by the last run-start must not cause
    // an error on one lane to mark the *other* lane's provider unhealthy.
    const v = reduceEvents([
      { t: "session", id: "run1", provider: "anthropic", model: "Opus 4.8", ts: 1 },
      { t: "text", lane: "anthropic", delta: "from anthropic" },
      { t: "text", lane: "openai", delta: "from openai" },
      { t: "session", id: "run2", provider: "openai", model: "GPT", ts: 2 },
      { t: "error", lane: "anthropic", code: "rate_limit", message: "429", retryable: true },
      { t: "done", lane: "openai", finishReason: "stop" },
    ]);
    const health = selectProviderHealth(v);
    expect(health.find((h) => h.provider === "anthropic")?.status).toBe("degraded");
    expect(health.find((h) => h.provider === "openai")?.status).toBe("ok");
  });

  it("ignores a stray 'done' or 'tool_result' with no live turn instead of minting a blank one", () => {
    const strayDone = reduceEvents([session, { t: "done", lane: "main", finishReason: "stop" }]);
    expect(selectFinalizedTurns(strayDone)).toHaveLength(0);
    expect(selectLiveTurn(strayDone)).toBeNull();
    expect(selectStreaming(strayDone)).toBe(false);

    const strayResult = reduceEvents([
      session,
      { t: "tool_result", lane: "main", id: "t1", ok: true, result: "ok" },
    ]);
    expect(selectFinalizedTurns(strayResult)).toHaveLength(0);
    expect(selectLiveTurn(strayResult)).toBeNull();
    expect(selectToolActivity(strayResult)).toHaveLength(0);
  });

  it("replaying a prefix yields the same view (time-travel safe)", () => {
    const events: UiEvent[] = [
      session,
      { t: "text", lane: "main", delta: "hi" },
      { t: "done", lane: "main", finishReason: "stop" },
    ];
    const full = reduceEvents(events);
    const stepwise = events.reduce(reduceEvent, initialViewState);
    const stable = (v: ReturnType<typeof reduceEvents>) =>
      selectAllFinalizedTurns(v).map((t) => ({ id: t.id, lane: t.lane, text: t.text, finished: t.finished }));
    // Deterministic ids: replaying the same log yields identical turn identity.
    expect(stable(full)).toEqual(stable(stepwise));
    expect(stable(full)).toEqual([{ id: "turn-main-0", lane: "main", text: "hi", finished: true }]);
    expect(full.eventCount).toBe(stepwise.eventCount);
  });

  it("folding the same event log twice yields byte-identical state, even if wall-clock time advances between folds", () => {
    const events: UiEvent[] = [
      session,
      { t: "text", lane: "main", delta: "hi" },
      { t: "reasoning", lane: "main", delta: "thinking" },
      { t: "tool_call", lane: "main", id: "t1", name: "read_file", args: { path: "a.ts" } },
      { t: "tool_result", lane: "main", id: "t1", ok: true, result: "ok" },
      { t: "usage", lane: "main", inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      { t: "done", lane: "main", finishReason: "stop" },
    ];
    const first = reduceEvents(events);

    // Advance the wall clock between folds — a pure fold must not leak it in.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Number.MAX_SAFE_INTEGER);
    const second = reduceEvents(events);
    nowSpy.mockRestore();

    expect(second).toEqual(first);
    // In particular, the re-fold does not re-stamp turns/health to "now".
    expect(selectAllFinalizedTurns(second)[0]?.startedTs).toBe(selectAllFinalizedTurns(first)[0]?.startedTs);
    expect(selectProviderHealth(second)).toEqual(selectProviderHealth(first));
  });
});

describe("EventStore", () => {
  it("appends, derives, and notifies subscribers", () => {
    const store = createEventStore();
    let notified = 0;
    const unsub = store.subscribe(() => (notified += 1));
    store.append(session, { t: "text", lane: "main", delta: "yo" });
    expect(notified).toBe(1);
    expect(selectLiveTurn(store.getView())?.text).toBe("yo");
    expect(store.getLog()).toHaveLength(2);
    unsub();
    store.append({ t: "done", lane: "main", finishReason: "stop" });
    expect(notified).toBe(1); // unsubscribed
  });

  it("seeds from an initial log", () => {
    const store = createEventStore([session]);
    expect(store.getView().session?.provider).toBe("anthropic");
  });
});
