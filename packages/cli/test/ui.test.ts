import { describe, it, expect } from "vitest";
import { chunkToUiEvents } from "../src/ui.js";
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
});
