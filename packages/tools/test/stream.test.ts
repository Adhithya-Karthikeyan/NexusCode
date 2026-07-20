import { describe, it, expect } from "vitest";
import {
  runTool,
  streamToolChunks,
  toolResultChunk,
  toolEventToChunk,
  type Tool,
  type ToolContext,
  type ToolEvent,
} from "@nexuscode/tools";

function ctx(): ToolContext {
  return { signal: new AbortController().signal, cwd: "/tmp", runId: "run-1" };
}

const batchTool: Tool = {
  name: "batch",
  description: "",
  parameters: {},
  permission: "read",
  run: async () => ({ ok: true, content: [{ type: "text", text: "hi" }] }),
};

const streamTool: Tool = {
  name: "stream",
  description: "",
  parameters: {},
  permission: "read",
  async *run(): AsyncIterable<ToolEvent> {
    yield { type: "progress", message: "starting" };
    yield { type: "output", content: [{ type: "text", text: "a" }] };
    yield { type: "output", content: [{ type: "text", text: "b" }] };
    yield { type: "result", result: { ok: true, content: [{ type: "text", text: "ab" }] } };
  },
};

const streamNoResult: Tool = {
  name: "stream2",
  description: "",
  parameters: {},
  permission: "read",
  async *run(): AsyncIterable<ToolEvent> {
    yield { type: "output", content: [{ type: "text", text: "x" }] };
    yield { type: "output", content: [{ type: "text", text: "y" }] };
  },
};

describe("StreamChunk mapping", () => {
  it("toolResultChunk carries content and only sets isError when true", () => {
    const ok = toolResultChunk("r", "call-1", { ok: true, content: [{ type: "text", text: "z" }] });
    expect(ok).toEqual({ type: "tool-result", runId: "r", toolCallId: "call-1", content: [{ type: "text", text: "z" }] });
    expect("isError" in ok).toBe(false);

    const bad = toolResultChunk("r", "call-1", { ok: false, content: [], isError: true });
    expect(bad).toMatchObject({ type: "tool-result", isError: true });
  });

  it("toolEventToChunk skips progress, maps output and result", () => {
    expect(toolEventToChunk("r", "c", { type: "progress", message: "m" })).toBeUndefined();
    const out = toolEventToChunk("r", "c", { type: "output", content: [{ type: "text", text: "o" }] });
    expect(out).toMatchObject({ type: "tool-result", content: [{ type: "text", text: "o" }] });
  });
});

describe("runTool driver", () => {
  it("returns the ToolResult of a batch tool", async () => {
    const r = await runTool(batchTool, {}, ctx());
    expect(r).toEqual({ ok: true, content: [{ type: "text", text: "hi" }] });
  });

  it("returns the terminal result of a streaming tool", async () => {
    const r = await runTool(streamTool, {}, ctx());
    expect(r).toEqual({ ok: true, content: [{ type: "text", text: "ab" }] });
  });

  it("synthesizes a result from accumulated output when none is emitted", async () => {
    const r = await runTool(streamNoResult, {}, ctx());
    expect(r).toEqual({
      ok: true,
      content: [
        { type: "text", text: "x" },
        { type: "text", text: "y" },
      ],
    });
  });
});

describe("streamToolChunks", () => {
  it("yields a single terminal chunk for a batch tool", async () => {
    const chunks = [];
    for await (const c of streamToolChunks(batchTool, {}, "call-9", ctx())) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ type: "tool-result", toolCallId: "call-9", runId: "run-1" });
  });

  it("yields incremental then terminal chunks for a streaming tool", async () => {
    const chunks = [];
    for await (const c of streamToolChunks(streamTool, {}, "call-9", ctx())) chunks.push(c);
    // progress is dropped; 2 output + 1 result = 3
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.type === "tool-result")).toBe(true);
  });
});
