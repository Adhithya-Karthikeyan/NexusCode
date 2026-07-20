import { describe, it, expect } from "vitest";
import type { CallContext } from "@nexuscode/core";
import type { ChatRequest, StreamChunk } from "@nexuscode/shared";
import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import {
  createBedrockAdapter,
  toBedrockRequest,
  mapBedrockEvent,
  newBedrockStreamState,
  mapError,
  mapMessages,
  type BedrockClientLike,
} from "@nexuscode/provider-bedrock";

const CFG = {
  modelMap: {
    sonnet: "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "anthropic.claude-3-5-sonnet-20241022-v2:0": "anthropic.claude-3-5-sonnet-20241022-v2:0",
  },
};

function ctx(signal: AbortSignal): CallContext {
  return { signal, idempotencyKey: "idem", traceId: "trace", runId: "run_bedrock" };
}

const SAMPLE_REQ: ChatRequest = {
  model: "sonnet",
  system: "be terse",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [{ name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } }],
  temperature: 0.5,
  maxTokens: 512,
};

describe("bedrock adapter — construction (offline, no creds)", () => {
  it("builds with the expected identity and native transport", () => {
    const adapter = createBedrockAdapter(CFG);
    expect(adapter.id).toBe("bedrock");
    expect(adapter.label).toBe("Amazon Bedrock");
    expect(adapter.transport).toBe("http-sdk");
  });

  it("reports capabilities without any network call", async () => {
    const caps = await createBedrockAdapter(CFG).capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.tools).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.cancel).toBe("abort-signal");
    expect(caps.models.some((m) => m.id === "anthropic.claude-3-5-sonnet-20241022-v2:0")).toBe(true);
  });

  it("honors per-model capability overrides (text-only model)", async () => {
    const caps = await createBedrockAdapter({ ...CFG, capabilityOverrides: { vision: false, tools: false } }).capabilities();
    expect(caps.vision).toBe(false);
    expect(caps.tools).toBe(false);
  });
});

describe("bedrock adapter — request translation (pure, no network)", () => {
  it("maps messages, system, tools, and inference config to native Converse shape", () => {
    const input = toBedrockRequest(CFG, SAMPLE_REQ);
    expect(input.modelId).toBe("anthropic.claude-3-5-sonnet-20241022-v2:0");
    expect(input.messages?.[0]?.role).toBe("user");
    expect((input.system?.[0] as { text?: string })?.text).toBe("be terse");
    expect(input.inferenceConfig?.maxTokens).toBe(512);
    expect(input.inferenceConfig?.temperature).toBe(0.5);
    const spec = (input.toolConfig?.tools?.[0] as { toolSpec?: { name?: string } })?.toolSpec;
    expect(spec?.name).toBe("get_weather");
  });

  it("maps assistant role and drops system messages from the message array", () => {
    const msgs = mapMessages([
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { role: "user", content: [{ type: "text", text: "u" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
    ]);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]?.role).toBe("user");
    expect(msgs[1]?.role).toBe("assistant");
  });

  it("drops toolConfig when toolChoice is 'none'", () => {
    const input = toBedrockRequest(CFG, { ...SAMPLE_REQ, toolChoice: "none" });
    expect(input.toolConfig).toBeUndefined();
  });

  it("maps a tool_use content block to a Bedrock toolUse block", () => {
    const msgs = mapMessages([
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x" } }] },
    ]);
    const block = msgs[0]?.content?.[0] as { toolUse?: { toolUseId?: string; name?: string } };
    expect(block.toolUse?.toolUseId).toBe("t1");
    expect(block.toolUse?.name).toBe("search");
  });
});

describe("bedrock adapter — stream event mapping (pure, fake events)", () => {
  it("maps a text delta event to a text-delta answer chunk", () => {
    const ev = { contentBlockDelta: { delta: { text: "hello" }, contentBlockIndex: 0 } } as unknown as ConverseStreamOutput;
    const out = mapBedrockEvent(ev, "run_bedrock", newBedrockStreamState());
    expect(out[0]).toMatchObject({ type: "text-delta", text: "hello", channel: "answer" });
  });

  it("maps a reasoningContent delta to a reasoning-delta chunk", () => {
    const ev = { contentBlockDelta: { delta: { reasoningContent: { text: "hmm" } }, contentBlockIndex: 0 } } as unknown as ConverseStreamOutput;
    const out = mapBedrockEvent(ev, "run_bedrock", newBedrockStreamState());
    expect(out[0]).toMatchObject({ type: "reasoning-delta", text: "hmm" });
  });

  it("maps a tool-use lifecycle: start -> delta -> stop with accumulated JSON", () => {
    const state = newBedrockStreamState();
    const start = { contentBlockStart: { start: { toolUse: { toolUseId: "tu1", name: "get_weather" } }, contentBlockIndex: 1 } } as unknown as ConverseStreamOutput;
    const delta = { contentBlockDelta: { delta: { toolUse: { input: '{"city":"SF"}' } }, contentBlockIndex: 1 } } as unknown as ConverseStreamOutput;
    const stop = { contentBlockStop: { contentBlockIndex: 1 } } as unknown as ConverseStreamOutput;

    expect(mapBedrockEvent(start, "r", state)[0]).toMatchObject({ type: "tool-call-start", id: "tu1", name: "get_weather" });
    expect(mapBedrockEvent(delta, "r", state)[0]).toMatchObject({ type: "tool-call-delta", id: "tu1", argsJsonDelta: '{"city":"SF"}' });
    expect(mapBedrockEvent(stop, "r", state)[0]).toMatchObject({ type: "tool-call-end", id: "tu1", input: { city: "SF" } });
  });

  it("maps a metadata event with usage to a usage chunk", () => {
    const ev = { metadata: { usage: { inputTokens: 12, outputTokens: 8 } } } as unknown as ConverseStreamOutput;
    const out = mapBedrockEvent(ev, "run_bedrock", newBedrockStreamState());
    expect(out[0]).toMatchObject({ type: "usage", usage: { inputTokens: 12, outputTokens: 8 } });
  });
});

describe("bedrock adapter — streaming against a fake client (no network)", () => {
  function fakeClient(events: ConverseStreamOutput[]): BedrockClientLike {
    return {
      async converseStream() {
        async function* gen() {
          for (const e of events) yield e;
        }
        return { stream: gen() };
      },
    };
  }

  it("emits run-start, deltas, usage, then run-end with the assembled message", async () => {
    const events = [
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { delta: { text: "Hi " }, contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { text: "there" }, contentBlockIndex: 0 } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
      { metadata: { usage: { inputTokens: 5, outputTokens: 3 } } },
    ] as unknown as ConverseStreamOutput[];

    const adapter = createBedrockAdapter({ ...CFG, createClient: () => fakeClient(events) });
    const chunks: StreamChunk[] = [];
    for await (const c of adapter.stream(SAMPLE_REQ, ctx(new AbortController().signal))) chunks.push(c);

    expect(chunks[0]?.type).toBe("run-start");
    const end = chunks.find((c) => c.type === "run-end");
    if (end?.type !== "run-end") throw new Error("no run-end");
    expect(end.finishReason).toBe("stop");
    expect(end.message.content.find((b) => b.type === "text")).toMatchObject({ type: "text", text: "Hi there" });
    expect(end.usage?.inputTokens).toBe(5);
  });

  it("assembles a tool_use block and reports finishReason tool_use", async () => {
    const events = [
      { contentBlockStart: { start: { toolUse: { toolUseId: "tu9", name: "get_weather" } }, contentBlockIndex: 0 } },
      { contentBlockDelta: { delta: { toolUse: { input: '{"city":"NYC"}' } }, contentBlockIndex: 0 } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "tool_use" } },
    ] as unknown as ConverseStreamOutput[];

    const adapter = createBedrockAdapter({ ...CFG, createClient: () => fakeClient(events) });
    const chunks: StreamChunk[] = [];
    for await (const c of adapter.stream(SAMPLE_REQ, ctx(new AbortController().signal))) chunks.push(c);

    const end = chunks.find((c) => c.type === "run-end");
    if (end?.type !== "run-end") throw new Error("no run-end");
    expect(end.finishReason).toBe("tool_use");
    const tu = end.message.content.find((b) => b.type === "tool_use");
    expect(tu).toMatchObject({ type: "tool_use", id: "tu9", name: "get_weather", input: { city: "NYC" } });
  });

  it("honors an already-aborted signal before any client call", async () => {
    const adapter = createBedrockAdapter({ ...CFG, createClient: () => { throw new Error("must not build client"); } });
    const ac = new AbortController();
    ac.abort();
    const chunks: StreamChunk[] = [];
    for await (const c of adapter.stream(SAMPLE_REQ, ctx(ac.signal))) chunks.push(c);
    const err = chunks.find((c) => c.type === "error");
    if (err?.type !== "error") throw new Error("expected error chunk");
    expect(err.error.code).toBe("cancelled");
    expect(err.retryable).toBe(false);
  });
});

describe("bedrock adapter — error mapping", () => {
  it("maps AWS exception names and statuses to the taxonomy", () => {
    expect(mapError({ name: "AccessDeniedException", message: "no", $metadata: { httpStatusCode: 403 } }).code).toBe("auth");
    expect(mapError({ name: "ThrottlingException", $metadata: { httpStatusCode: 429 } }).code).toBe("rate_limit");
    expect(mapError({ name: "ServiceUnavailableException", $metadata: { httpStatusCode: 503 } }).code).toBe("overloaded");
    expect(mapError({ name: "ValidationException", message: "input is too long, maximum tokens", $metadata: { httpStatusCode: 400 } }).code).toBe("context_length");
    expect(mapError({ name: "ValidationException", message: "bad field", $metadata: { httpStatusCode: 400 } }).code).toBe("invalid_request");
    expect(mapError({ name: "SomethingElse", message: "boom", $metadata: { httpStatusCode: 500 } }).code).toBe("transport");
  });

  it("rate_limit and overloaded are retryable; auth is not", () => {
    expect(mapError({ name: "ThrottlingException" }).retryable).toBe(true);
    expect(mapError({ name: "ServiceUnavailableException" }).retryable).toBe(true);
    expect(mapError({ name: "AccessDeniedException" }).retryable).toBe(false);
  });
});
