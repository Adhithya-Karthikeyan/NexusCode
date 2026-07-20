import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import {
  toOpenAIMessages,
  createOpenAIAdapter,
  createGrokAdapter,
} from "@nexuscode/provider-openai";
import type { Message } from "@nexuscode/core";

/**
 * Vision + audio wiring for the OpenAI / OpenAI-compat transport, verified as
 * pure functions with no network and no SDK client construction:
 *
 *  - an image content block maps to a Chat Completions `image_url` part
 *    (base64 → `data:` URL, remote → passthrough URL);
 *  - an audio content block maps to an `input_audio` part with the right format;
 *  - capabilities report vision/audio/embeddings correctly per provider;
 *  - the optional `embed()` method exists only where the backend supports it.
 */

type UserParam = OpenAI.ChatCompletionUserMessageParam;
type ContentPart = OpenAI.ChatCompletionContentPart;

function partsOfFirstUser(messages: Message[]): ContentPart[] {
  const [m] = toOpenAIMessages(messages);
  expect(m?.role).toBe("user");
  const content = (m as UserParam).content;
  expect(Array.isArray(content)).toBe(true);
  return content as ContentPart[];
}

describe("openai convert — image content block → image_url part", () => {
  it("maps a base64 image to a data: URL image_url part", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image", mime: "image/png", data: "AAABBB" },
        ],
      },
    ];
    const parts = partsOfFirstUser(msgs);
    expect(parts).toContainEqual({ type: "text", text: "what is this?" });
    expect(parts).toContainEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,AAABBB" },
    });
  });

  it("passes a remote image URL straight through", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "image", mime: "image/jpeg", data: { url: "https://x/y.jpg" } }] },
    ];
    const parts = partsOfFirstUser(msgs);
    expect(parts).toContainEqual({
      type: "image_url",
      image_url: { url: "https://x/y.jpg" },
    });
  });
});

describe("openai convert — audio content block → input_audio part", () => {
  it("maps base64 wav audio to an input_audio part with format wav", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "audio", mime: "audio/wav", data: "WAVDATA" }] },
    ];
    const parts = partsOfFirstUser(msgs);
    expect(parts).toContainEqual({
      type: "input_audio",
      input_audio: { data: "WAVDATA", format: "wav" },
    });
  });

  it("derives format mp3 from an mp3/mpeg mime type", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "audio", mime: "audio/mpeg", data: "MP3DATA" }] },
    ];
    const parts = partsOfFirstUser(msgs);
    expect(parts).toContainEqual({
      type: "input_audio",
      input_audio: { data: "MP3DATA", format: "mp3" },
    });
  });

  it("degrades a URL-only audio reference to a text note (no URL audio on the wire)", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "audio", mime: "audio/wav", data: { url: "https://x/a.wav" } }] },
    ];
    const parts = partsOfFirstUser(msgs);
    expect(parts).toContainEqual({ type: "text", text: "[audio: https://x/a.wav]" });
  });
});

describe("openai/compat — capabilities + optional embed()", () => {
  it("native OpenAI reports vision, audio and embeddings, and exposes embed()", async () => {
    const adapter = createOpenAIAdapter();
    const caps = await adapter.capabilities();
    expect(caps.vision).toBe(true);
    expect(caps.audio).toBe(true);
    expect(caps.embeddings).toBe(true);
    expect(typeof adapter.embed).toBe("function");
  });

  it("a plain compat provider (grok) reports no audio/embeddings and has no embed()", async () => {
    const adapter = createGrokAdapter();
    const caps = await adapter.capabilities();
    expect(caps.audio ?? false).toBe(false);
    expect(caps.embeddings ?? false).toBe(false);
    expect(adapter.embed).toBeUndefined();
  });
});
