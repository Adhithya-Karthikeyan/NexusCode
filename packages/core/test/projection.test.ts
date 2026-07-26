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
