import { describe, it, expect } from "vitest";
import { toNativeRequest, createAnthropicAdapter } from "@nexuscode/provider-anthropic";
import type { AnthropicConfig } from "@nexuscode/provider-anthropic";
import type { ChatRequest } from "@nexuscode/core";

/**
 * Vision wiring for the native Anthropic adapter, verified as a pure function
 * (`toNativeRequest`) with no network and no SDK client:
 *
 *  - a base64 image block maps to a `{ type: "base64" }` image source;
 *  - a URL image block maps to a `{ type: "url" }` image source;
 *  - an audio block (unsupported by Anthropic) folds to a lossless text note;
 *  - capabilities report vision:true, audio:false, embeddings:false.
 */

const CFG: AnthropicConfig = { modelMap: { default: "claude-sonnet-4-6" } };

function firstContent(req: ChatRequest): unknown[] {
  const native = toNativeRequest(CFG, req);
  const msg = native.messages[0];
  return msg?.content as unknown[];
}

function reqWith(content: ChatRequest["messages"][number]["content"]): ChatRequest {
  return { model: "default", messages: [{ role: "user", content }] };
}

describe("anthropic toNativeRequest — image content block → native source", () => {
  it("maps a base64 image to a base64 image source", () => {
    const [block] = firstContent(reqWith([{ type: "image", mime: "image/png", data: "AAABBB" }]));
    expect(block).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "AAABBB" },
    });
  });

  it("maps a URL image to a url image source", () => {
    const [block] = firstContent(reqWith([{ type: "image", mime: "image/jpeg", data: { url: "https://x/y.jpg" } }]));
    expect(block).toEqual({
      type: "image",
      source: { type: "url", url: "https://x/y.jpg" },
    });
  });

  it("folds an audio block to a lossless text note (Anthropic has no audio input)", () => {
    const [block] = firstContent(reqWith([{ type: "audio", mime: "audio/wav", data: "WAV" }]));
    expect(block).toEqual({ type: "text", text: "[audio: audio/wav]" });
  });
});

describe("anthropic — capabilities", () => {
  it("reports vision:true and audio/embeddings:false", async () => {
    const adapter = createAnthropicAdapter(CFG, async () => "test-key");
    const caps = await adapter.capabilities();
    expect(caps.vision).toBe(true);
    expect(caps.audio).toBe(false);
    expect(caps.embeddings).toBe(false);
    expect(adapter.embed).toBeUndefined();
  });
});
