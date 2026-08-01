import { describe, it, expect, vi } from "vitest";
import type { CallContext } from "@nexuscode/core";
import type { ChatRequest, StreamChunk } from "@nexuscode/shared";

/**
 * Fake-client streaming coverage for the native Anthropic adapter's `stream()`
 * (packages/providers/anthropic/src/index.ts:737-830), modeled on the
 * fake-client pattern in packages/providers/bedrock/test/bedrock.test.ts.
 *
 * Unlike Bedrock, `AnthropicConfig` has no `createClient` DI seam — the SDK
 * client is always `new Anthropic(opts)`. So the whole `@anthropic-ai/sdk`
 * module is mocked here (scoped to this file only) so `anthropic.messages
 * .stream()` returns a scripted fake `MessageStream`: an async-iterable of
 * SDK events plus a `finalMessage()` resolving to the assembled `Message`,
 * exactly like the real SDK's `MessageStream` class.
 */

const { streamImpl } = vi.hoisted(() => ({
  streamImpl: {
    current: undefined as unknown as (...args: unknown[]) => FakeMessageStream,
  },
}));

interface FakeMessageStream {
  [Symbol.asyncIterator](): AsyncIterator<unknown>;
  finalMessage(): Promise<unknown>;
}

vi.mock("@anthropic-ai/sdk", () => {
  class FakeAPIError extends Error {
    status?: number | undefined;
    headers?: Record<string, string> | undefined;
    constructor(status?: number, error?: unknown, message?: string, headers?: Record<string, string>) {
      super(message ?? "api error");
      this.status = status;
      this.headers = headers;
    }
  }
  class FakeAnthropic {
    static APIError = FakeAPIError;
    messages = {
      stream: (...args: unknown[]) => streamImpl.current(...args),
    };
  }
  return { default: FakeAnthropic };
});

const { createAnthropicAdapter } = await import("@nexuscode/provider-anthropic");

/** A fake `MessageStream`: yields scripted events, then resolves `finalMessage()`. */
function fakeStream(events: unknown[], final: unknown): FakeMessageStream {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const e of events) yield e;
    },
    async finalMessage() {
      return final;
    },
  };
}

const CFG = { modelMap: { claude: "claude-sonnet-4-5" } };

function ctx(signal: AbortSignal): CallContext {
  return { signal, idempotencyKey: "idem", traceId: "trace", runId: "run_anthropic" };
}

const SAMPLE_REQ: ChatRequest = {
  model: "claude",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [{ name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } }],
};

function adapter() {
  return createAnthropicAdapter(CFG, async () => "sk-ant-test");
}

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe("anthropic adapter — streaming against a fake SDK client (no network)", () => {
  it("plain text deltas: run-start, text-delta x N, usage, run-end with assembled text + finishReason stop", async () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "there" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
      { type: "message_stop" },
    ];
    const final = {
      content: [{ type: "text", text: "Hi there" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 3 },
    };
    streamImpl.current = () => fakeStream(events, final);

    const chunks = await collect(adapter().stream(SAMPLE_REQ, ctx(new AbortController().signal)));

    expect(chunks[0]?.type).toBe("run-start");
    const textDeltas = chunks.filter((c) => c.type === "text-delta");
    expect(textDeltas.map((c) => (c.type === "text-delta" ? c.text : ""))).toEqual(["Hi ", "there"]);
    for (const c of textDeltas) expect(c).toMatchObject({ channel: "answer" });

    const usage = chunks.find((c) => c.type === "usage");
    expect(usage?.type === "usage" && usage.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });

    const end = chunks[chunks.length - 1];
    if (end?.type !== "run-end") throw new Error("expected run-end");
    expect(end.finishReason).toBe("stop");
    expect(end.message).toMatchObject({ role: "assistant", content: [{ type: "text", text: "Hi there" }] });
    expect(end.usage).toMatchObject({ inputTokens: 5, outputTokens: 3 });
    for (const c of chunks) expect(c.runId).toBe("run_anthropic");
  });

  it("tool_use lifecycle: content_block_start -> multi-part input_json_delta -> content_block_stop assembles the full JSON into tool-call-end", async () => {
    const events = [
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "get_weather", input: {} },
      },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"cit' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'y":"S' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'F"}' } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 12 } },
    ];
    const final = {
      content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "SF" } }],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 12 },
    };
    streamImpl.current = () => fakeStream(events, final);

    const chunks = await collect(adapter().stream(SAMPLE_REQ, ctx(new AbortController().signal)));

    const start = chunks.find((c) => c.type === "tool-call-start");
    expect(start).toMatchObject({ type: "tool-call-start", id: "tu_1", name: "get_weather" });

    const deltas = chunks.filter((c) => c.type === "tool-call-delta");
    expect(deltas.map((c) => (c.type === "tool-call-delta" ? c.argsJsonDelta : ""))).toEqual([
      '{"cit',
      'y":"S',
      'F"}',
    ]);
    for (const d of deltas) expect(d).toMatchObject({ id: "tu_1" });

    // PROV-1: content_block_stop must close the tool with the fully assembled
    // JSON args, not silently drop the terminal chunk.
    const end = chunks.find((c) => c.type === "tool-call-end");
    expect(end).toMatchObject({ type: "tool-call-end", id: "tu_1", input: { city: "SF" } });

    const runEnd = chunks[chunks.length - 1];
    if (runEnd?.type !== "run-end") throw new Error("expected run-end");
    expect(runEnd.finishReason).toBe("tool_use");
    expect(runEnd.message.content.find((b) => b.type === "tool_use")).toMatchObject({
      type: "tool_use",
      id: "tu_1",
      name: "get_weather",
      input: { city: "SF" },
    });

    // Ordering: start strictly before every delta, every delta before end.
    const startIdx = chunks.indexOf(start!);
    const endIdx = chunks.indexOf(end!);
    expect(startIdx).toBeLessThan(chunks.indexOf(deltas[0]!));
    expect(chunks.indexOf(deltas[deltas.length - 1]!)).toBeLessThan(endIdx);
  });

  it("a thinking_delta maps to a reasoning-delta chunk, and the assembled thinking block survives to run-end", async () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me work through this. " } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Answer is 42." } },
      { type: "content_block_stop", index: 0 },
      { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "42" } },
      { type: "content_block_stop", index: 1 },
    ];
    const final = {
      content: [
        { type: "thinking", thinking: "Let me work through this. Answer is 42.", signature: "sig-abc" },
        { type: "text", text: "42" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 8, output_tokens: 4 },
    };
    streamImpl.current = () => fakeStream(events, final);

    const chunks = await collect(adapter().stream(SAMPLE_REQ, ctx(new AbortController().signal)));

    const reasoning = chunks.filter((c) => c.type === "reasoning-delta");
    expect(reasoning.map((c) => (c.type === "reasoning-delta" ? c.text : ""))).toEqual([
      "Let me work through this. ",
      "Answer is 42.",
    ]);
    // No tool chunks and no spurious text-delta from the thinking block itself.
    expect(chunks.some((c) => c.type === "tool-call-start")).toBe(false);

    const end = chunks[chunks.length - 1];
    if (end?.type !== "run-end") throw new Error("expected run-end");
    expect(end.message.content).toEqual([
      { type: "thinking", text: "Let me work through this. Answer is 42.", signature: "sig-abc" },
      { type: "text", text: "42" },
    ]);
  });

  it("message_delta/finalMessage usage + stop_reason mapping: max_tokens -> length, cache tokens surfaced", async () => {
    const events = [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "truncated" } },
      { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 4096 } },
    ];
    const final = {
      content: [{ type: "text", text: "truncated" }],
      stop_reason: "max_tokens",
      usage: {
        input_tokens: 100,
        output_tokens: 4096,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 10,
      },
    };
    streamImpl.current = () => fakeStream(events, final);

    const chunks = await collect(adapter().stream(SAMPLE_REQ, ctx(new AbortController().signal)));
    const end = chunks[chunks.length - 1];
    if (end?.type !== "run-end") throw new Error("expected run-end");
    expect(end.finishReason).toBe("length");
    expect(end.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 4096,
      cacheReadTokens: 30,
      cacheWriteTokens: 10,
    });
  });
});

describe("anthropic adapter — cancellation", () => {
  it("a pre-aborted signal short-circuits to run-start then a terminal cancelled AdapterError, never building a client", async () => {
    const ac = new AbortController();
    ac.abort();
    const credSpy = vi.fn(async () => {
      throw new Error("must not resolve a credential for a pre-aborted signal");
    });
    const streamSpy = vi.fn();
    streamImpl.current = streamSpy;

    const chunks = await collect(
      createAnthropicAdapter(CFG, credSpy).stream(SAMPLE_REQ, ctx(ac.signal)),
    );

    expect(chunks[0]?.type).toBe("run-start");
    const last = chunks[chunks.length - 1];
    if (last?.type !== "error") throw new Error("expected terminal error chunk");
    expect(last.error.code).toBe("cancelled");
    expect(last.retryable).toBe(false);
    expect(credSpy).not.toHaveBeenCalled();
    expect(streamSpy).not.toHaveBeenCalled();
  });

  it("aborting mid-stream (between fake events) surfaces a terminal cancelled AdapterError, not a thrown AbortError", async () => {
    const ac = new AbortController();
    let sawAbortInGenerator = false;

    streamImpl.current = () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } };
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "partial" } };
        // Simulate the real SDK tearing the socket down when ctx.signal fires
        // mid-stream: the caller's AbortController fires, then the iterator
        // throws — exactly what a real fetch abort does.
        ac.abort();
        sawAbortInGenerator = true;
        throw new DOMException("The user aborted a request.", "AbortError");
      },
      async finalMessage(): Promise<never> {
        throw new Error("finalMessage must not be reached after a mid-stream abort");
      },
    });

    const chunks: StreamChunk[] = [];
    // Must not throw out of the for-await — the adapter normalizes the abort
    // into a terminal `error` chunk instead of letting it propagate.
    for await (const c of adapter().stream(SAMPLE_REQ, ctx(ac.signal))) {
      chunks.push(c);
    }

    expect(sawAbortInGenerator).toBe(true);
    expect(chunks[0]?.type).toBe("run-start");
    const last = chunks[chunks.length - 1];
    if (last?.type !== "error") throw new Error("expected terminal error chunk");
    expect(last.error.code).toBe("cancelled");
    expect(last.retryable).toBe(false);
    // Exactly one terminal chunk — no error surfaced ahead of it either.
    expect(chunks.filter((c) => c.type === "run-end" || c.type === "error")).toHaveLength(1);
  });
});
