import { describe, it, expect } from "vitest";
import { chunkToUiEvents, laneKey } from "@nexuscode/core";
import type { StreamChunk } from "@nexuscode/shared";

describe("chunkToUiEvents — usage projection", () => {
  it("projects exactly one usage UiEvent from the dedicated usage chunk, not again from run-end", () => {
    const usage = { inputTokens: 3, outputTokens: 5, costUsd: 0 };

    const usageChunk = { type: "usage", runId: "run_1", usage } as StreamChunk;
    const runEndChunk = {
      type: "run-end",
      runId: "run_1",
      finishReason: "stop",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      usage,
      ts: Date.now(),
    } as StreamChunk;

    const events = [...chunkToUiEvents(usageChunk, "main"), ...chunkToUiEvents(runEndChunk, "main")];
    const usageEvents = events.filter((e) => e.t === "usage");

    expect(usageEvents).toHaveLength(1);
    expect(events.some((e) => e.t === "done")).toBe(true);
  });

  it("still emits the usage event when only the usage chunk is present", () => {
    const usage = { inputTokens: 1, outputTokens: 1, costUsd: 0 };
    const events = chunkToUiEvents({ type: "usage", runId: "run_2", usage } as StreamChunk, "main");
    expect(events).toHaveLength(1);
    expect(events[0]?.t).toBe("usage");
  });

  it("resolves the lane key (single collapses to main, compare keeps adapter id)", () => {
    expect(laneKey(0, ["mock"], true)).toBe("main");
    expect(laneKey(1, ["anthropic", "openai"], false)).toBe("openai");
  });
});

describe("chunkToUiEvents — unknown pricing is NOT the same as free (cost honesty)", () => {
  it("a model with no pricing entry (costUsd/reportedCostUsd both absent) projects costUsd: null, never 0", () => {
    // No `costUsd` and no `reportedCostUsd` — this is what a real paid call
    // looks like when the model has no entry in the pricing table. Rendering
    // it as `$0.00` would silently misrepresent a paid call as free.
    const usage = { inputTokens: 100, outputTokens: 50 };
    const events = chunkToUiEvents({ type: "usage", runId: "run_3", usage } as StreamChunk, "main");
    const usageEvent = events.find((e) => e.t === "usage");
    expect(usageEvent).toBeDefined();
    expect(usageEvent && usageEvent.t === "usage" ? usageEvent.costUsd : "missing").toBeNull();
  });

  it("a priced model still projects its real computed cost, unchanged", () => {
    const usage = { inputTokens: 100, outputTokens: 50, costUsd: 0.0042 };
    const events = chunkToUiEvents({ type: "usage", runId: "run_4", usage } as StreamChunk, "main");
    const usageEvent = events.find((e) => e.t === "usage");
    expect(usageEvent && usageEvent.t === "usage" ? usageEvent.costUsd : null).toBeCloseTo(0.0042, 6);
  });

  it("a genuinely free provider (costUsd: 0) reads as zero, not conflated with unknown", () => {
    const usage = { inputTokens: 100, outputTokens: 50, costUsd: 0 };
    const events = chunkToUiEvents({ type: "usage", runId: "run_5", usage } as StreamChunk, "main");
    const usageEvent = events.find((e) => e.t === "usage");
    expect(usageEvent && usageEvent.t === "usage" ? usageEvent.costUsd : "missing").toBe(0);
  });

  it("a CLI-reported cost (reportedCostUsd) is still honored when costUsd itself is absent", () => {
    const usage = { inputTokens: 100, outputTokens: 50, reportedCostUsd: 0.02 };
    const events = chunkToUiEvents({ type: "usage", runId: "run_6", usage } as StreamChunk, "main");
    const usageEvent = events.find((e) => e.t === "usage");
    expect(usageEvent && usageEvent.t === "usage" ? usageEvent.costUsd : null).toBeCloseTo(0.02, 6);
  });
});

describe("chunkToUiEvents — session event's sessionId (bug fix)", () => {
  const runStart = {
    type: "run-start",
    runId: "run_abc",
    adapterId: "mock",
    model: "mock-fast",
    ts: 0,
  } as StreamChunk;

  it("omits sessionId when the caller doesn't have one (backward compatible)", () => {
    const events = chunkToUiEvents(runStart, "main");
    const session = events.find((e) => e.t === "session");
    expect(session).toBeDefined();
    expect(session).not.toHaveProperty("sessionId");
    // `id` — the run id — is untouched, for callers that only ever knew this field.
    expect(session).toMatchObject({ id: "run_abc" });
  });

  it("carries the engine session id, distinct from the run id, when the caller passes one", () => {
    const events = chunkToUiEvents(runStart, "main", "s_xyz");
    const session = events.find((e) => e.t === "session");
    expect(session).toMatchObject({ id: "run_abc", sessionId: "s_xyz" });
  });
});

describe("chunkToUiEvents — agent-loop metadata (coordinator progress chunks)", () => {
  // Hand-built to mirror `agentMetaChunk()`'s shape (`packages/agent/src/events.ts`)
  // without importing from `@nexuscode/agent` — `@nexuscode/core` must not
  // depend on it.
  it("projects [agent, reasoning] in order, with phase/role/step/data intact, for an agentMetaChunk-shaped text-delta", () => {
    const chunk = {
      type: "text-delta",
      runId: "run_1",
      channel: "reasoning",
      text: "Drafting a plan…",
      raw: { agent: { phase: "plan", role: "coordinator", step: 2, data: { steps: ["a", "b"] } } },
    } as StreamChunk;

    const events = chunkToUiEvents(chunk, "main");

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      t: "agent",
      lane: "main",
      phase: "plan",
      role: "coordinator",
      step: 2,
      text: "Drafting a plan…",
      data: { steps: ["a", "b"] },
    });
    expect(events[1]).toEqual({ t: "reasoning", lane: "main", delta: "Drafting a plan…" });
  });

  it("carries the same narration on the agent event's `text` as the paired reasoning event's `delta`", () => {
    const chunk = {
      type: "text-delta",
      runId: "run_1",
      channel: "reasoning",
      text: "Reflecting on step 2…",
      raw: { agent: { phase: "reflect", role: "coordinator", step: 2 } },
    } as StreamChunk;

    const events = chunkToUiEvents(chunk, "main");

    const agentEvent = events.find((e) => e.t === "agent");
    const reasoningEvent = events.find((e) => e.t === "reasoning");
    expect(agentEvent).toMatchObject({ text: "Reflecting on step 2…" });
    expect(reasoningEvent).toMatchObject({ delta: "Reflecting on step 2…" });
    expect((agentEvent as { text: string }).text).toBe((reasoningEvent as { delta: string }).delta);
  });

  it("still projects exactly one reasoning event for a plain reasoning text-delta with no raw (no regression)", () => {
    const chunk = { type: "text-delta", runId: "run_1", channel: "reasoning", text: "thinking…" } as StreamChunk;

    const events = chunkToUiEvents(chunk, "main");

    expect(events).toEqual([{ t: "reasoning", lane: "main", delta: "thinking…" }]);
  });

  it("does not half-match a wrong-shaped raw — non-string phase produces only the reasoning event", () => {
    const chunk = {
      type: "text-delta",
      runId: "run_1",
      channel: "reasoning",
      text: "thinking…",
      raw: { agent: { phase: 123, role: "coordinator", step: 1 } },
    } as unknown as StreamChunk;

    const events = chunkToUiEvents(chunk, "main");

    expect(events).toEqual([{ t: "reasoning", lane: "main", delta: "thinking…" }]);
  });

  it("does not half-match a wrong-shaped raw — an unrelated raw.failover payload produces only the reasoning event", () => {
    const chunk = {
      type: "text-delta",
      runId: "run_1",
      channel: "reasoning",
      text: "thinking…",
      raw: { failover: [{ from: "a", to: "b", code: "x", message: "m" }] },
    } as StreamChunk;

    const events = chunkToUiEvents(chunk, "main");

    expect(events).toEqual([{ t: "reasoning", lane: "main", delta: "thinking…" }]);
  });

  it("omits data from the agent event when the source meta has no data", () => {
    const chunk = {
      type: "text-delta",
      runId: "run_1",
      channel: "reasoning",
      text: "stepping…",
      raw: { agent: { phase: "step-start", role: "worker", step: 0 } },
    } as StreamChunk;

    const events = chunkToUiEvents(chunk, "main");

    expect(events[0]).toEqual({ t: "agent", lane: "main", phase: "step-start", role: "worker", step: 0, text: "stepping…" });
    expect(events[0]).not.toHaveProperty("data");
  });
});
