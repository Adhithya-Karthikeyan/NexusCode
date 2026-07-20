import { describe, it, expect } from "vitest";
import type { CallContext } from "@nexuscode/core";
import type { ChatRequest, StreamChunk } from "@nexuscode/shared";
import {
  createGeminiAdapter,
  toGeminiRequest,
  mapGeminiChunk,
  mapError,
  mapMessages,
  GEMINI_API_KEY_ENV,
  type GeminiChunkLike,
  type GeminiClientLike,
} from "@nexuscode/provider-gemini";

const CFG = { modelMap: { flash: "gemini-2.0-flash", "gemini-2.0-flash": "gemini-2.0-flash" } };

function ctx(signal: AbortSignal): CallContext {
  return { signal, idempotencyKey: "idem", traceId: "trace", runId: "run_gemini" };
}

const SAMPLE_REQ: ChatRequest = {
  model: "flash",
  system: "be terse",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [{ name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } }],
  temperature: 0.4,
  maxTokens: 256,
  reasoning: { enabled: true, budgetTokens: 1234 },
};

describe("gemini adapter — construction (offline, no creds)", () => {
  it("builds with the expected identity and native transport", () => {
    const adapter = createGeminiAdapter(CFG);
    expect(adapter.id).toBe("gemini");
    expect(adapter.label).toBe("Google Gemini");
    expect(adapter.transport).toBe("http-sdk");
  });

  it("labels vertex mode distinctly", () => {
    const adapter = createGeminiAdapter({ ...CFG, vertex: true, project: "p", location: "us-central1" });
    expect(adapter.label).toBe("Google Vertex (Gemini)");
  });

  it("reports the right capabilities without any network call", async () => {
    const caps = await createGeminiAdapter(CFG).capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.tools).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.cancel).toBe("abort-signal");
    expect(caps.models.some((m) => m.id === "gemini-2.0-flash")).toBe(true);
    expect(caps.models[0]?.modalities).toContain("audio");
  });
});

describe("gemini adapter — request translation (pure, no network)", () => {
  it("maps messages, system, tools, and reasoning to native shape", () => {
    const native = toGeminiRequest(CFG, SAMPLE_REQ);
    expect(native.model).toBe("gemini-2.0-flash");
    expect(Array.isArray(native.contents)).toBe(true);
    const contents = native.contents as Array<{ role?: string; parts?: unknown[] }>;
    expect(contents[0]?.role).toBe("user");
    expect(native.config?.systemInstruction).toBe("be terse");
    expect(native.config?.temperature).toBe(0.4);
    expect(native.config?.maxOutputTokens).toBe(256);
    expect(native.config?.tools?.[0]?.functionDeclarations?.[0]?.name).toBe("get_weather");
    expect(native.config?.thinkingConfig?.thinkingBudget).toBe(1234);
    expect(native.config?.thinkingConfig?.includeThoughts).toBe(true);
  });

  it("maps assistant role to gemini 'model' and drops system messages from contents", () => {
    const contents = mapMessages([
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { role: "user", content: [{ type: "text", text: "u" }] },
      { role: "assistant", content: [{ type: "text", text: "a" }] },
    ]);
    expect(contents).toHaveLength(2);
    expect(contents[0]?.role).toBe("user");
    expect(contents[1]?.role).toBe("model");
  });

  it("drops tools when toolChoice is 'none'", () => {
    const native = toGeminiRequest(CFG, { ...SAMPLE_REQ, toolChoice: "none" });
    expect(native.config?.tools).toBeUndefined();
  });
});

describe("gemini adapter — stream event mapping (pure, fake events)", () => {
  it("maps a text part to a text-delta answer chunk", () => {
    const ev: GeminiChunkLike = { candidates: [{ content: { parts: [{ text: "hello" }] } }] };
    const out = mapGeminiChunk(ev, "run_gemini");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "text-delta", text: "hello", channel: "answer", runId: "run_gemini" });
  });

  it("maps a thought part to a reasoning-delta chunk", () => {
    const ev: GeminiChunkLike = { candidates: [{ content: { parts: [{ text: "pondering", thought: true }] } }] };
    const out = mapGeminiChunk(ev, "run_gemini");
    expect(out[0]).toMatchObject({ type: "reasoning-delta", text: "pondering" });
  });

  it("maps a functionCall part to matched tool-call-start + tool-call-end", () => {
    const ev: GeminiChunkLike = {
      candidates: [{ content: { parts: [{ functionCall: { id: "c1", name: "get_weather", args: { city: "SF" } } }] } }],
    };
    const out = mapGeminiChunk(ev, "run_gemini");
    expect(out[0]).toMatchObject({ type: "tool-call-start", id: "c1", name: "get_weather" });
    expect(out[1]).toMatchObject({ type: "tool-call-end", id: "c1", input: { city: "SF" } });
  });

  it("maps usageMetadata to a usage chunk", () => {
    const ev: GeminiChunkLike = { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 } };
    const out = mapGeminiChunk(ev, "run_gemini");
    expect(out[0]).toMatchObject({ type: "usage", usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 } });
  });
});

describe("gemini adapter — streaming against a fake client (no network)", () => {
  function fakeClient(chunks: GeminiChunkLike[]): GeminiClientLike {
    return {
      models: {
        async generateContentStream() {
          async function* gen() {
            for (const c of chunks) yield c as never;
          }
          return gen();
        },
      },
    };
  }

  it("emits run-start, deltas, usage, then run-end with an assembled message", async () => {
    const adapter = createGeminiAdapter({
      ...CFG,
      createClient: () =>
        fakeClient([
          { candidates: [{ content: { parts: [{ text: "Hello " }] } }] },
          { candidates: [{ content: { parts: [{ text: "world" }], role: "model" }, finishReason: "STOP" }] },
          { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 } },
        ]),
    });
    const chunks: StreamChunk[] = [];
    for await (const c of adapter.stream(SAMPLE_REQ, ctx(new AbortController().signal))) chunks.push(c);

    expect(chunks[0]?.type).toBe("run-start");
    const end = chunks.find((c) => c.type === "run-end");
    expect(end?.type).toBe("run-end");
    if (end?.type !== "run-end") throw new Error("no run-end");
    expect(end.finishReason).toBe("stop");
    const text = end.message.content.find((b) => b.type === "text");
    expect(text).toMatchObject({ type: "text", text: "Hello world" });
    expect(end.usage?.inputTokens).toBe(7);
  });

  it("honors an already-aborted signal with a cancelled error before any client call", async () => {
    const adapter = createGeminiAdapter({ ...CFG, createClient: () => { throw new Error("must not build client"); } });
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

describe("gemini adapter — error mapping + no-cred posture", () => {
  it("maps HTTP-ish statuses to the taxonomy", () => {
    expect(mapError({ status: 401, message: "bad key" }).code).toBe("auth");
    expect(mapError({ status: 429, message: "slow down" }).code).toBe("rate_limit");
    expect(mapError({ status: 503, message: "overloaded" }).code).toBe("overloaded");
    expect(mapError({ status: 400, message: "too many tokens, maximum exceeded" }).code).toBe("context_length");
    expect(mapError({ status: 500, message: "boom" }).code).toBe("transport");
  });

  it("redacts secrets from error messages", () => {
    const err = mapError({ status: 403, message: "invalid key=AIzaSecret123 and Bearer abc.def" });
    expect(err.message).not.toContain("AIzaSecret123");
    expect(err.message).not.toContain("abc.def");
  });

  it("with no key (dev API), stream fails fast with a non-retryable auth error", async () => {
    const prev = process.env[GEMINI_API_KEY_ENV];
    delete process.env[GEMINI_API_KEY_ENV];
    try {
      const adapter = createGeminiAdapter(CFG);
      const chunks: StreamChunk[] = [];
      for await (const c of adapter.stream(SAMPLE_REQ, ctx(new AbortController().signal))) chunks.push(c);
      const err = chunks.find((c) => c.type === "error");
      if (err?.type !== "error") throw new Error("expected error chunk");
      expect(err.error.code).toBe("auth");
      expect(err.retryable).toBe(false);
    } finally {
      if (prev !== undefined) process.env[GEMINI_API_KEY_ENV] = prev;
    }
  });
});
