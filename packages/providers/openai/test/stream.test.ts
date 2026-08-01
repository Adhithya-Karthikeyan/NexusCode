import { describe, it, expect, vi } from "vitest";
import type OpenAI from "openai";
import type { CallContext } from "@nexuscode/core";
import type { StreamChunk } from "@nexuscode/shared";
import { streamChatCompletion } from "../src/stream.js";

/**
 * Unit coverage for `streamChatCompletion` (src/stream.ts:72-200) against a
 * stub `OpenAI` client whose `chat.completions.create()` returns a scripted
 * async iterable of `ChatCompletionChunk`s — no network, no real SDK client.
 */

type Chunk = OpenAI.Chat.Completions.ChatCompletionChunk;
type StreamingParams = OpenAI.ChatCompletionCreateParamsStreaming;

function ctx(signal: AbortSignal): CallContext {
  return { signal, idempotencyKey: "idem", traceId: "trace", runId: "run_openai" };
}

const BODY: StreamingParams = {
  model: "gpt-4o",
  stream: true,
  messages: [{ role: "user", content: "hi" }],
};

/** A stub `OpenAI` client whose `chat.completions.create()` yields scripted chunks. */
function stubClient(chunks: Chunk[], createSpy?: (body: unknown, opts: unknown) => void): OpenAI {
  const client = {
    chat: {
      completions: {
        create: async (body: unknown, opts: unknown) => {
          createSpy?.(body, opts);
          return {
            [Symbol.asyncIterator]: async function* () {
              for (const c of chunks) yield c;
            },
          };
        },
      },
    },
  };
  return client as unknown as OpenAI;
}

function chunk(partial: Partial<Chunk> & { choices: Chunk["choices"] }): Chunk {
  return { id: "c1", object: "chat.completion.chunk", created: 0, model: "gpt-4o", ...partial } as Chunk;
}

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe("streamChatCompletion — interleaved tool calls", () => {
  it("two tool calls at indexes 0 and 1, deltas interleaved, each assembles independently and in order", async () => {
    const chunks: Chunk[] = [
      chunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_a", function: { name: "get_weather", arguments: "" } }] },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 1, id: "call_b", function: { name: "get_time", arguments: "" } }] },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] }, finish_reason: null },
        ],
      }),
      chunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{"zone":' } }] }, finish_reason: null },
        ],
      }),
      chunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] }, finish_reason: null },
        ],
      }),
      chunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '"UTC"}' } }] }, finish_reason: null },
        ],
      }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    ];

    const client = stubClient(chunks);
    const out = await collect(streamChatCompletion(client, BODY, ctx(new AbortController().signal), "openai"));

    const starts = out.filter((c) => c.type === "tool-call-start");
    expect(starts.map((c) => (c.type === "tool-call-start" ? c.id : ""))).toEqual(["call_a", "call_b"]);
    expect(starts.map((c) => (c.type === "tool-call-start" ? c.name : ""))).toEqual(["get_weather", "get_time"]);

    const deltasForA = out.filter((c) => c.type === "tool-call-delta" && c.id === "call_a");
    const deltasForB = out.filter((c) => c.type === "tool-call-delta" && c.id === "call_b");
    expect(deltasForA.map((c) => (c.type === "tool-call-delta" ? c.argsJsonDelta : ""))).toEqual(['{"city":', '"SF"}']);
    expect(deltasForB.map((c) => (c.type === "tool-call-delta" ? c.argsJsonDelta : ""))).toEqual(['{"zone":', '"UTC"}']);

    const ends = out.filter((c) => c.type === "tool-call-end");
    expect(ends).toHaveLength(2);
    expect(ends.find((c) => c.type === "tool-call-end" && c.id === "call_a")).toMatchObject({
      id: "call_a",
      input: { city: "SF" },
    });
    expect(ends.find((c) => c.type === "tool-call-end" && c.id === "call_b")).toMatchObject({
      id: "call_b",
      input: { zone: "UTC" },
    });

    // Assembled independently AND in first-seen order: end for call_a precedes end for call_b.
    const endIds = out.filter((c) => c.type === "tool-call-end").map((c) => (c.type === "tool-call-end" ? c.id : ""));
    expect(endIds).toEqual(["call_a", "call_b"]);

    const end = out[out.length - 1];
    if (end?.type !== "run-end") throw new Error("expected run-end");
    expect(end.finishReason).toBe("tool_use");
    const toolBlocks = end.message.content.filter((b) => b.type === "tool_use");
    expect(toolBlocks).toHaveLength(2);
    expect(toolBlocks[0]).toMatchObject({ id: "call_a", name: "get_weather", input: { city: "SF" } });
    expect(toolBlocks[1]).toMatchObject({ id: "call_b", name: "get_time", input: { zone: "UTC" } });
  });

  it("a tool call whose id arrives before its name waits for the name before announcing tool-call-start", async () => {
    const chunks: Chunk[] = [
      chunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_late_name" }] }, finish_reason: null }] }),
      chunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: null },
        ],
      }),
      chunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { name: "search" } }] }, finish_reason: null },
        ],
      }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    ];

    const client = stubClient(chunks);
    const out = await collect(streamChatCompletion(client, BODY, ctx(new AbortController().signal), "openai"));

    // No tool-call-start until the id AND the name are both known. The
    // arguments delta that arrived before the name was accumulated silently
    // (no tool-call-delta chunk for it, since the call had not yet started).
    const starts = out.filter((c) => c.type === "tool-call-start");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ id: "call_late_name", name: "search" });
    expect(out.filter((c) => c.type === "tool-call-delta")).toHaveLength(0);

    const end = out.find((c) => c.type === "tool-call-end");
    // The pre-start arguments ("{}") are still folded into the final input.
    expect(end).toMatchObject({ id: "call_late_name", input: {} });
  });
});

describe("streamChatCompletion — refusal-only stream", () => {
  it("a refusal with no content text yields no text-delta chunks, finishes content_filter, and the refusal text lands in the final message", async () => {
    const chunks: Chunk[] = [
      chunk({ choices: [{ index: 0, delta: { refusal: "I can't help with " }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: { refusal: "that." }, finish_reason: null }] }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }),
    ];

    const client = stubClient(chunks);
    const out = await collect(streamChatCompletion(client, BODY, ctx(new AbortController().signal), "openai"));

    expect(out.some((c) => c.type === "text-delta")).toBe(false);
    expect(out.some((c) => c.type === "tool-call-start")).toBe(false);

    const end = out[out.length - 1];
    if (end?.type !== "run-end") throw new Error("expected run-end");
    expect(end.finishReason).toBe("content_filter");
    expect(end.message.content).toEqual([{ type: "text", text: "I can't help with that." }]);
  });
});

describe("streamChatCompletion — malformed tool-argument JSON falls back to the raw string", () => {
  it("unparsable accumulated arguments are passed through as-is rather than dropped or thrown", async () => {
    const chunks: Chunk[] = [
      chunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: "call_bad", function: { name: "run", arguments: "" } }] },
            finish_reason: null,
          },
        ],
      }),
      chunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{not valid json" } }] }, finish_reason: null },
        ],
      }),
      chunk({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    ];

    const client = stubClient(chunks);
    const out = await collect(streamChatCompletion(client, BODY, ctx(new AbortController().signal), "openai"));

    const end = out.find((c) => c.type === "tool-call-end");
    if (end?.type !== "tool-call-end") throw new Error("expected tool-call-end");
    expect(end.input).toBe("{not valid json");

    const runEnd = out[out.length - 1];
    if (runEnd?.type !== "run-end") throw new Error("expected run-end");
    const toolBlock = runEnd.message.content.find((b) => b.type === "tool_use");
    expect(toolBlock).toMatchObject({ id: "call_bad", name: "run", input: "{not valid json" });
  });
});

describe("streamChatCompletion — zeroCost rewrites usage.costUsd to 0", () => {
  it("a zeroCost config zeroes costUsd on both the usage chunk and run-end's usage", async () => {
    const chunks: Chunk[] = [
      chunk({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }),
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    ];

    const client = stubClient(chunks);
    const out = await collect(
      streamChatCompletion(client, BODY, ctx(new AbortController().signal), "ollama", { zeroCost: true }),
    );

    const usageChunk = out.find((c) => c.type === "usage");
    if (usageChunk?.type !== "usage") throw new Error("expected a usage chunk");
    expect(usageChunk.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, costUsd: 0 });

    const end = out[out.length - 1];
    if (end?.type !== "run-end") throw new Error("expected run-end");
    expect(end.usage).toMatchObject({ inputTokens: 10, outputTokens: 2, costUsd: 0 });
  });

  it("without zeroCost, usage carries no costUsd field at all (nothing computes it here)", async () => {
    const chunks: Chunk[] = [
      chunk({ choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }),
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }),
    ];

    const client = stubClient(chunks);
    const out = await collect(streamChatCompletion(client, BODY, ctx(new AbortController().signal), "openai"));

    const usageChunk = out.find((c) => c.type === "usage");
    if (usageChunk?.type !== "usage") throw new Error("expected a usage chunk");
    expect(usageChunk.usage.costUsd).toBeUndefined();
  });
});

describe("streamChatCompletion — request wiring", () => {
  it("threads ctx.signal into client.chat.completions.create", async () => {
    const ac = new AbortController();
    let seenSignal: unknown;
    const client = stubClient(
      [chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })],
      (_body, opts) => {
        seenSignal = (opts as { signal?: unknown }).signal;
      },
    );
    await collect(streamChatCompletion(client, BODY, ctx(ac.signal), "openai"));
    expect(seenSignal).toBe(ac.signal);
  });

  it("a pre-aborted signal short-circuits to a terminal cancelled error without ever calling create()", async () => {
    const ac = new AbortController();
    ac.abort();
    const createSpy = vi.fn();
    const client = stubClient([], createSpy);
    const out = await collect(streamChatCompletion(client, BODY, ctx(ac.signal), "openai"));

    expect(out[0]?.type).toBe("run-start");
    const last = out[out.length - 1];
    if (last?.type !== "error") throw new Error("expected terminal error chunk");
    expect(last.error.code).toBe("cancelled");
    expect(last.retryable).toBe(false);
    expect(createSpy).not.toHaveBeenCalled();
  });
});
