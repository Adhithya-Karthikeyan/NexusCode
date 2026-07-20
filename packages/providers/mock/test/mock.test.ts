import { describe, it, expect } from "vitest";
import { createMockAdapter } from "@nexuscode/provider-mock";
import type { CallContext } from "@nexuscode/core";
import type { ChatRequest, StreamChunk } from "@nexuscode/shared";

function ctx(signal: AbortSignal, runId = "run_test"): CallContext {
  return { signal, idempotencyKey: "idem_test", traceId: "trace_test", runId };
}

function req(text: string, model = "mock-fast"): ChatRequest {
  return { model, messages: [{ role: "user", content: [{ type: "text", text }] }] };
}

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe("mock adapter — streaming contract", () => {
  it("yields ordered chunks: run-start → text-deltas → usage → run-end", async () => {
    const adapter = createMockAdapter();
    const ac = new AbortController();
    const chunks = await collect(adapter.stream(req("hi there"), ctx(ac.signal)));

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0]?.type).toBe("run-start");

    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("run-end");

    // run-end is terminal: nothing follows it.
    const endIndex = chunks.findIndex((c) => c.type === "run-end");
    expect(endIndex).toBe(chunks.length - 1);

    // At least one text delta, and a usage chunk before the end.
    const textDeltas = chunks.filter((c) => c.type === "text-delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(chunks.some((c) => c.type === "usage")).toBe(true);

    // Concatenated deltas reproduce the final message text exactly.
    const streamed = textDeltas.map((c) => (c.type === "text-delta" ? c.text : "")).join("");
    const end = last;
    if (end?.type !== "run-end") throw new Error("expected run-end");
    expect(end.finishReason).toBe("stop");
    const finalText = end.message.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    expect(streamed).toBe(finalText);
    expect(finalText).toContain("hi there");
  });

  it("every stream chunk carries the ctx.runId", async () => {
    const adapter = createMockAdapter();
    const ac = new AbortController();
    const chunks = await collect(adapter.stream(req("x"), ctx(ac.signal, "run_ABC")));
    for (const c of chunks) expect(c.runId).toBe("run_ABC");
  });

  it("chat() buffers the stream into a ChatResult", async () => {
    const adapter = createMockAdapter();
    const ac = new AbortController();
    const result = await adapter.chat(req("buffer me"), ctx(ac.signal));
    expect(result.finishReason).toBe("stop");
    const text = result.message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(text).toContain("buffer me");
    expect(result.usage?.outputTokens).toBeGreaterThan(0);
  });

  it("is deterministic: identical requests produce identical output", async () => {
    const adapter = createMockAdapter();
    const a = await adapter.chat(req("same"), ctx(new AbortController().signal));
    const b = await adapter.chat(req("same"), ctx(new AbortController().signal));
    expect(JSON.stringify(a.message)).toBe(JSON.stringify(b.message));
  });

  it("advertises streaming + abort-signal cancellation in capabilities", async () => {
    const adapter = createMockAdapter();
    const caps = await adapter.capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.cancel).toBe("abort-signal");
    expect(caps.models.length).toBeGreaterThan(0);
  });
});

describe("mock adapter — cancellation", () => {
  it("aborting mid-stream yields a terminal cancelled error and no run-end", async () => {
    const adapter = createMockAdapter({ delayMs: 25 });
    const ac = new AbortController();
    const chunks: StreamChunk[] = [];
    let didAbort = false;

    for await (const c of adapter.stream(req("cancel me please with several words"), ctx(ac.signal))) {
      chunks.push(c);
      if (c.type === "text-delta" && !didAbort) {
        didAbort = true;
        ac.abort();
      }
    }

    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type !== "error") throw new Error("expected terminal error");
    expect(last.error.code).toBe("cancelled");
    expect(last.retryable).toBe(false);
    expect(chunks.some((c) => c.type === "run-end")).toBe(false);
  });

  it("a pre-aborted signal cancels before any content is produced", async () => {
    const adapter = createMockAdapter();
    const ac = new AbortController();
    ac.abort();
    const chunks = await collect(adapter.stream(req("never runs"), ctx(ac.signal)));
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type !== "error") throw new Error("expected terminal error");
    expect(last.error.code).toBe("cancelled");
    expect(chunks.some((c) => c.type === "text-delta")).toBe(false);
  });
});

describe("mock adapter — tool-calling model (mock-tools)", () => {
  it("advertises tools:true when a tool model is present", async () => {
    const caps = await createMockAdapter().capabilities();
    expect(caps.tools).toBe(true);
    expect(caps.models.some((m) => m.id === "mock-tools")).toBe(true);
  });

  it("first turn emits a single native tool call and finishes with tool_use", async () => {
    const adapter = createMockAdapter();
    const chunks = await collect(adapter.stream(req("some/path.txt", "mock-tools"), ctx(new AbortController().signal)));

    expect(chunks[0]?.type).toBe("run-start");
    expect(chunks.some((c) => c.type === "tool-call-start")).toBe(true);
    const end = chunks.find((c) => c.type === "tool-call-end");
    if (end?.type !== "tool-call-end") throw new Error("expected tool-call-end");
    expect(end.input).toEqual({ path: "some/path.txt" });

    const runEnd = chunks[chunks.length - 1];
    if (runEnd?.type !== "run-end") throw new Error("expected run-end");
    expect(runEnd.finishReason).toBe("tool_use");
    // The assistant message carries the tool_use block for re-invocation.
    expect(runEnd.message.content.some((b) => b.type === "tool_use")).toBe(true);
    // No text answer on the tool-calling turn.
    expect(chunks.some((c) => c.type === "text-delta")).toBe(false);
  });

  it("emits a final text answer once a tool result is in the conversation", async () => {
    const adapter = createMockAdapter();
    const conversation: ChatRequest = {
      model: "mock-tools",
      messages: [
        { role: "user", content: [{ type: "text", text: "read the file" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "fs_read", input: { path: "f" } }] },
        { role: "tool", toolCallId: "call_1", content: [{ type: "text", text: "FILE_BODY" }] },
      ],
    };
    const chunks = await collect(adapter.stream(conversation, ctx(new AbortController().signal)));

    // This turn produces no further tool calls, just the final answer.
    expect(chunks.some((c) => c.type === "tool-call-start")).toBe(false);
    const textDeltas = chunks.filter((c) => c.type === "text-delta");
    expect(textDeltas.length).toBeGreaterThan(0);
    const runEnd = chunks[chunks.length - 1];
    if (runEnd?.type !== "run-end") throw new Error("expected run-end");
    expect(runEnd.finishReason).toBe("stop");
    const text = runEnd.message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(text).toContain("FILE_BODY");
  });

  it("is deterministic and honors a custom tool name/input transform", async () => {
    const adapter = createMockAdapter({ toolName: "echo", toolInput: (p) => ({ text: p }) });
    const chunks = await collect(adapter.stream(req("hi", "mock-tools"), ctx(new AbortController().signal)));
    const start = chunks.find((c) => c.type === "tool-call-start");
    if (start?.type !== "tool-call-start") throw new Error("expected tool-call-start");
    expect(start.name).toBe("echo");
    const end = chunks.find((c) => c.type === "tool-call-end");
    if (end?.type !== "tool-call-end") throw new Error("expected tool-call-end");
    expect(end.input).toEqual({ text: "hi" });
  });
});
