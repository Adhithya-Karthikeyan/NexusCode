import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockAdapter } from "@nexuscode/provider-mock";
import type { ToolContext, ToolResult } from "@nexuscode/tools";
import { isNexusError } from "@nexuscode/shared";
import type { ContentBlock } from "@nexuscode/shared";
import {
  createAiTools,
  createAiVisionTool,
  createAiOcrTool,
  createAiImageGenerateTool,
  createAiSpeechTool,
} from "../src/index.js";
import type { AiToolDeps } from "../src/index.js";

/**
 * Every AI tool is exercised fully OFFLINE:
 *   - vision/ocr(provider fallback) route through the deterministic mock adapter;
 *   - ocr/image/speech run against injected FAKE engines (deterministic);
 *   - the "no backend" path degrades gracefully to an isError ToolResult.
 * Nothing here touches the network, a real model, or a real client library.
 */

// A tiny valid 1x1 PNG (base64), used as inline image data and file content.
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// A tiny fake WAV-ish blob for audio inputs (content is irrelevant to the fake).
const AUDIO_B64 = Buffer.from("fake-audio-bytes").toString("base64");

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tools-ai-"));
  await writeFile(join(dir, "pic.png"), Buffer.from(PNG_1x1, "base64"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, cwd: dir };
}

function textOf(result: { content: ContentBlock[] }): string {
  return result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

describe("factory + contract", () => {
  it("createAiTools returns the four AI tools with a network permission", () => {
    const tools = createAiTools({});
    expect(tools.map((t) => t.name)).toEqual([
      "ai_vision",
      "ai_ocr",
      "ai_image_generate",
      "ai_speech",
    ]);
    for (const t of tools) {
      expect(t.permission).toBe("network");
      expect(typeof t.timeoutMs).toBe("number");
      expect(t.parameters).toMatchObject({ type: "object" });
      expect(typeof t.run).toBe("function");
    }
  });
});

describe("ai_vision", () => {
  it("analyzes inline image data via the mock provider (deterministic)", async () => {
    const tool = createAiVisionTool({ provider: createMockAdapter(), model: "mock-smart" });
    const res = (await tool.run(
      { prompt: "What is in this picture?", data: PNG_1x1, mime: "image/png" },
      ctx(),
    )) as ToolResult;
    expect(res.ok).toBe(true);
    expect(res.isError).toBeFalsy();
    const text = textOf(res);
    expect(text).toContain("[mock-smart]");
    expect(text).toContain("What is in this picture?");
  });

  it("reads a workspace image path (confined)", async () => {
    const tool = createAiVisionTool({ provider: createMockAdapter() });
    const res = (await tool.run({ path: "pic.png" }, ctx())) as ToolResult;
    expect(res.ok).toBe(true);
    expect(textOf(res)).toContain("Describe this image");
  });

  it("rejects a path that escapes the workspace (invalid_argument)", async () => {
    const tool = createAiVisionTool({ provider: createMockAdapter() });
    await expect(tool.run({ path: "../../etc/passwd" }, ctx())).rejects.toSatisfy(isNexusError);
  });

  it("degrades gracefully with no provider configured", async () => {
    const tool = createAiVisionTool({});
    const res = (await tool.run({ data: PNG_1x1, mime: "image/png" }, ctx())) as ToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no provider configured/);
  });

  it("returns an error result when the provider stream is cancelled", async () => {
    const ac = new AbortController();
    ac.abort();
    const tool = createAiVisionTool({ provider: createMockAdapter() });
    const res = (await tool.run({ data: PNG_1x1, mime: "image/png" }, ctx(ac.signal))) as ToolResult;
    expect(res.isError).toBe(true);
  });

  it("caps oversized output", async () => {
    const long = "x".repeat(5000);
    const provider = createMockAdapter({ transform: () => long });
    const tool = createAiVisionTool({ provider, maxOutputChars: 100 });
    const res = (await tool.run({ data: PNG_1x1, mime: "image/png" }, ctx())) as ToolResult;
    expect(textOf(res)).toContain("[truncated at 100 characters]");
  });
});

describe("ai_ocr", () => {
  it("uses an injected OCR engine (deterministic)", async () => {
    const deps: AiToolDeps = {
      ocr: async (args) => ({ text: `OCR<${args.mime}:${args.lang ?? "auto"}>: HELLO`, confidence: 0.99 }),
    };
    const tool = createAiOcrTool(deps);
    const res = (await tool.run({ data: PNG_1x1, mime: "image/png", lang: "eng" }, ctx())) as ToolResult;
    expect(res.ok).toBe(true);
    expect(textOf(res)).toBe("OCR<image/png:eng>: HELLO");
  });

  it("falls back to the vision provider when no OCR engine is present", async () => {
    const tool = createAiOcrTool({ provider: createMockAdapter() });
    const res = (await tool.run({ path: "pic.png" }, ctx())) as ToolResult;
    expect(res.ok).toBe(true);
    expect(textOf(res)).toContain("Perform OCR");
  });

  it("degrades gracefully with no engine, library, or provider", async () => {
    const tool = createAiOcrTool({});
    const res = (await tool.run({ data: PNG_1x1, mime: "image/png" }, ctx())) as ToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/npm i tesseract\.js/);
  });
});

describe("ai_image_generate", () => {
  it("uses an injected generator and returns image content blocks", async () => {
    const deps: AiToolDeps = {
      imageGenerator: async (req) =>
        Array.from({ length: req.count ?? 1 }, () => ({ mime: "image/png", data: PNG_1x1 })),
    };
    const tool = createAiImageGenerateTool(deps);
    const res = (await tool.run({ prompt: "a red cube", count: 2 }, ctx())) as ToolResult;
    expect(res.ok).toBe(true);
    const images = res.content.filter((b) => b.type === "image");
    expect(images).toHaveLength(2);
    expect(textOf(res)).toContain("a red cube");
  });

  it("clamps count to maxImages", async () => {
    const deps: AiToolDeps = {
      maxImages: 3,
      imageGenerator: async (req) =>
        Array.from({ length: req.count ?? 1 }, () => ({ mime: "image/png", data: PNG_1x1 })),
    };
    const tool = createAiImageGenerateTool(deps);
    const res = (await tool.run({ prompt: "many", count: 99 }, ctx())) as ToolResult;
    expect(res.content.filter((b) => b.type === "image")).toHaveLength(3);
  });

  it("degrades gracefully with no backend", async () => {
    const tool = createAiImageGenerateTool({});
    const res = (await tool.run({ prompt: "anything" }, ctx())) as ToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/npm i openai/);
  });

  it("throws invalid_argument when prompt is missing", async () => {
    const tool = createAiImageGenerateTool({ imageGenerator: async () => [] });
    await expect(tool.run({}, ctx())).rejects.toSatisfy(isNexusError);
  });
});

describe("ai_speech", () => {
  it("tts uses an injected synthesizer and returns an audio block", async () => {
    const deps: AiToolDeps = {
      speech: { synthesize: async (a) => ({ mime: "audio/mpeg", data: Buffer.from(a.text).toString("base64") }) },
    };
    const tool = createAiSpeechTool(deps);
    const res = (await tool.run({ mode: "tts", text: "hello world", voice: "alloy" }, ctx())) as ToolResult;
    expect(res.ok).toBe(true);
    const audio = res.content.find((b) => b.type === "audio") as
      | { type: "audio"; mime: string; data: string }
      | undefined;
    expect(audio?.mime).toBe("audio/mpeg");
    expect(Buffer.from(audio!.data, "base64").toString()).toBe("hello world");
  });

  it("stt uses an injected transcriber and returns text", async () => {
    const deps: AiToolDeps = {
      speech: { transcribe: async (a) => ({ text: `transcript<${a.mime}>` }) },
    };
    const tool = createAiSpeechTool(deps);
    const res = (await tool.run({ mode: "stt", data: AUDIO_B64, mime: "audio/wav" }, ctx())) as ToolResult;
    expect(res.ok).toBe(true);
    expect(textOf(res)).toBe("transcript<audio/wav>");
  });

  it("tts degrades gracefully with no backend", async () => {
    const tool = createAiSpeechTool({});
    const res = (await tool.run({ mode: "tts", text: "hi" }, ctx())) as ToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no TTS backend/);
  });

  it("stt degrades gracefully with no backend", async () => {
    const tool = createAiSpeechTool({});
    const res = (await tool.run({ mode: "stt", data: AUDIO_B64, mime: "audio/wav" }, ctx())) as ToolResult;
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no STT backend/);
  });

  it("throws invalid_argument for tts without text", async () => {
    const tool = createAiSpeechTool({ speech: { synthesize: async () => ({ mime: "audio/mpeg", data: "" }) } });
    await expect(tool.run({ mode: "tts" }, ctx())).rejects.toSatisfy(isNexusError);
  });
});
