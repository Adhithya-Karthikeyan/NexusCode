import { describe, it, expect } from "vitest";
import { createEventProjector, PROJECTOR_VERSION } from "../src/projector.js";
import type { StreamChunk } from "@nexuscode/shared";

describe("EventProjector", () => {
  it("tool-call-start → execution-event delta", () => {
    const proj = createEventProjector();
    const chunk: StreamChunk = {
      type: "tool-call-start",
      runId: "r1",
      id: "call1",
      name: "bash",
    };
    const deltas = proj.project(chunk, {
      runId: "r1",
      turnId: "t1",
      lamportTs: 1,
      projectorVersion: PROJECTOR_VERSION,
    });
    expect(deltas.length).toBe(1);
    expect(deltas[0]!.op).toBe("execution-event");
    if (deltas[0]!.op === "execution-event") {
      expect(deltas[0]!.fields.action).toBe("bash");
      expect(deltas[0]!.fields.result).toBe("in-progress");
    }
  });

  it("tool-result (error) → execution-event with result failure", () => {
    const proj = createEventProjector();
    const chunk: StreamChunk = {
      type: "tool-result",
      runId: "r1",
      toolCallId: "call1",
      content: [{ type: "text", text: "boom" }],
      isError: true,
    };
    const deltas = proj.project(chunk, {
      runId: "r1",
      turnId: "t1",
      lamportTs: 2,
      projectorVersion: PROJECTOR_VERSION,
    });
    expect(deltas[0]!.op).toBe("execution-event");
    if (deltas[0]!.op === "execution-event") {
      expect(deltas[0]!.fields.result).toBe("failure");
    }
  });

  it("run-end → execution-event with result from status", () => {
    const proj = createEventProjector();
    const chunk: StreamChunk = {
      type: "run-end",
      runId: "r1",
      finishReason: "stop",
      message: { role: "assistant", content: [] },
      ts: 99,
    };
    const deltas = proj.project(chunk, {
      runId: "r1",
      turnId: "t1",
      lamportTs: 3,
      projectorVersion: PROJECTOR_VERSION,
    });
    expect(deltas[0]!.op).toBe("execution-event");
    if (deltas[0]!.op === "execution-event") {
      expect(deltas[0]!.fields.result).toBe("success");
    }
  });

  it("unknown type → delta with result unknown + rawType", () => {
    const proj = createEventProjector();
    const chunk = {
      type: "mystery-event",
      runId: "r1",
      payload: 42,
    } as unknown as StreamChunk;
    const deltas = proj.project(chunk, {
      runId: "r1",
      turnId: "t1",
      lamportTs: 4,
      projectorVersion: PROJECTOR_VERSION,
    });
    expect(deltas.length).toBe(1);
    expect(deltas[0]!.op).toBe("execution-event");
    if (deltas[0]!.op === "execution-event") {
      expect(deltas[0]!.fields.result).toBe("unknown");
      expect(deltas[0]!.fields.rawType).toBe("mystery-event");
    }
  });

  it("recovers the tool name on tool-call-end / tool-result from a prior tool-call-start", () => {
    const proj = createEventProjector();
    const ctx = (lamportTs: number) => ({
      runId: "r1",
      turnId: "t1",
      lamportTs,
      projectorVersion: PROJECTOR_VERSION,
    });
    // tool-call-start seeds the callId→name map for this run.
    proj.project(
      { type: "tool-call-start", runId: "r1", id: "call1", name: "bash" } as StreamChunk,
      ctx(1),
    );
    const end = proj.project(
      { type: "tool-call-end", runId: "r1", id: "call1", input: {} } as StreamChunk,
      ctx(2),
    );
    const res = proj.project(
      { type: "tool-result", runId: "r1", toolCallId: "call1", content: [], isError: false } as StreamChunk,
      ctx(3),
    );
    if (end[0]!.op === "execution-event") expect(end[0]!.fields.action).toBe("bash");
    if (res[0]!.op === "execution-event") expect(res[0]!.fields.action).toBe("bash");
  });

  it("falls back to the chunk type when no prior tool-call-start named the call", () => {
    const proj = createEventProjector();
    const res = proj.project(
      { type: "tool-result", runId: "r1", toolCallId: "orphan", content: [], isError: true } as StreamChunk,
      { runId: "r1", turnId: "t1", lamportTs: 1, projectorVersion: PROJECTOR_VERSION },
    );
    if (res[0]!.op === "execution-event") expect(res[0]!.fields.action).toBe("tool-result");
  });

  it("projectorVersion is set", () => {
    expect(PROJECTOR_VERSION).toBeGreaterThan(0);
    const proj = createEventProjector();
    const chunk: StreamChunk = {
      type: "tool-call-start",
      runId: "r1",
      id: "c",
      name: "bash",
    };
    const deltas = proj.project(chunk, {
      runId: "r1",
      turnId: "t1",
      lamportTs: 1,
      projectorVersion: PROJECTOR_VERSION,
    });
    if (deltas[0]!.op === "execution-event") {
      expect(deltas[0]!.fields.projectorVersion).toBe(PROJECTOR_VERSION);
    }
  });
});