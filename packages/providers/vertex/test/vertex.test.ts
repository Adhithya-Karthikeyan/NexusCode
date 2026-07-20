import { describe, it, expect } from "vitest";
import type { CallContext } from "@nexuscode/core";
import type { ChatRequest, StreamChunk } from "@nexuscode/shared";
import type { GeminiClientLike, GeminiChunkLike } from "@nexuscode/provider-gemini";
import {
  createVertexAdapter,
  toVertexRequest,
  mapVertexChunk,
  mapError,
} from "@nexuscode/provider-vertex";

const CFG = {
  modelMap: { gemini: "gemini-2.0-flash", "gemini-2.0-flash": "gemini-2.0-flash" },
  project: "my-proj",
  location: "us-central1",
};

function ctx(signal: AbortSignal): CallContext {
  return { signal, idempotencyKey: "idem", traceId: "trace", runId: "run_vertex" };
}

const SAMPLE_REQ: ChatRequest = {
  model: "gemini",
  system: "be terse",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [{ name: "get_weather", description: "weather", parameters: { type: "object", properties: {} } }],
  temperature: 0.3,
  maxTokens: 128,
};

describe("vertex adapter — construction (offline, no creds)", () => {
  it("builds with the expected identity and native transport", () => {
    const adapter = createVertexAdapter(CFG);
    expect(adapter.id).toBe("vertex");
    expect(adapter.label).toBe("Google Vertex AI");
    expect(adapter.transport).toBe("http-sdk");
  });

  it("reports capabilities without any network call", async () => {
    const caps = await createVertexAdapter(CFG).capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.tools).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.cancel).toBe("abort-signal");
    expect(caps.models.some((m) => m.id === "gemini-2.0-flash")).toBe(true);
    expect(caps.models[0]?.modalities).toContain("audio");
  });
});

describe("vertex adapter — request translation (pure, no network)", () => {
  it("maps to the shared generateContent shape (project/location auth is out-of-band)", () => {
    const native = toVertexRequest(CFG, SAMPLE_REQ);
    expect(native.model).toBe("gemini-2.0-flash");
    expect(native.config?.systemInstruction).toBe("be terse");
    expect(native.config?.temperature).toBe(0.3);
    expect(native.config?.maxOutputTokens).toBe(128);
    expect(native.config?.tools?.[0]?.functionDeclarations?.[0]?.name).toBe("get_weather");
    const contents = native.contents as Array<{ role?: string }>;
    expect(contents[0]?.role).toBe("user");
  });
});

describe("vertex adapter — stream event mapping (pure, fake events)", () => {
  it("maps a text part to a text-delta chunk", () => {
    const ev: GeminiChunkLike = { candidates: [{ content: { parts: [{ text: "yo" }] } }] };
    expect(mapVertexChunk(ev, "run_vertex")[0]).toMatchObject({ type: "text-delta", text: "yo", channel: "answer" });
  });

  it("maps a functionCall part to matched tool-call start/end", () => {
    const ev: GeminiChunkLike = {
      candidates: [{ content: { parts: [{ functionCall: { id: "c1", name: "get_weather", args: { city: "LA" } } }] } }],
    };
    const out = mapVertexChunk(ev, "run_vertex");
    expect(out[0]).toMatchObject({ type: "tool-call-start", id: "c1", name: "get_weather" });
    expect(out[1]).toMatchObject({ type: "tool-call-end", id: "c1", input: { city: "LA" } });
  });
});

describe("vertex adapter — streaming against a fake client (no network)", () => {
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
    const adapter = createVertexAdapter({
      ...CFG,
      createClient: () =>
        fakeClient([
          { candidates: [{ content: { parts: [{ text: "Bon" }] } }] },
          { candidates: [{ content: { parts: [{ text: "jour" }] }, finishReason: "STOP" }] },
          { usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 } },
        ]),
    });
    const chunks: StreamChunk[] = [];
    for await (const c of adapter.stream(SAMPLE_REQ, ctx(new AbortController().signal))) chunks.push(c);

    expect(chunks[0]?.type).toBe("run-start");
    const end = chunks.find((c) => c.type === "run-end");
    if (end?.type !== "run-end") throw new Error("no run-end");
    expect(end.finishReason).toBe("stop");
    expect(end.message.content.find((b) => b.type === "text")).toMatchObject({ type: "text", text: "Bonjour" });
    expect(end.usage?.inputTokens).toBe(4);
  });

  it("honors an already-aborted signal before any client call", async () => {
    const adapter = createVertexAdapter({ ...CFG, createClient: () => { throw new Error("must not build client"); } });
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

describe("vertex adapter — error mapping (reused from gemini)", () => {
  it("maps HTTP-ish statuses to the taxonomy", () => {
    expect(mapError({ status: 401, message: "bad" }).code).toBe("auth");
    expect(mapError({ status: 429, message: "slow" }).code).toBe("rate_limit");
    expect(mapError({ status: 503, message: "down" }).code).toBe("overloaded");
    expect(mapError({ status: 500, message: "boom" }).code).toBe("transport");
  });
});
