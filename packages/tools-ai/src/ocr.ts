/**
 * `ai_ocr` — extract text from an image.
 *
 * Resolution order (first available wins):
 *   1. An injected `ocr` engine (a fake in tests).
 *   2. The optional-lazy `tesseract.js` package, if installed.
 *   3. The injected vision `provider` (OCR-by-prompt fallback).
 * When none is available the tool returns a clear `isError` result with an
 * install hint. Permission class: `network`.
 */

import type { ChatRequest } from "@nexuscode/shared";
import { errText, okText } from "@nexuscode/tools";
import type { Tool, ToolContext, ToolResult } from "@nexuscode/tools";
import type { AiToolDeps, OcrArgs } from "./types.js";
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_TIMEOUT_MS,
  callContext,
  cap,
  completeText,
  loadMedia,
  optionalImport,
  timeoutSignal,
} from "./support.js";
import { asObject, optString } from "./validate.js";

const OCR_PROMPT =
  "Perform OCR on this image. Return ONLY the exact text you can read, preserving line breaks. No commentary.";

interface TesseractModule {
  recognize?: (image: unknown, lang?: string) => Promise<{ data?: { text?: string; confidence?: number } }>;
}

export function createAiOcrTool(deps: AiToolDeps): Tool {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = deps.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  return {
    name: "ai_ocr",
    description:
      "Extract text from an image via OCR. Uses an injected OCR engine, the optional tesseract.js library, or a vision provider. Accepts a workspace image path or inline base64 data.",
    permission: "network",
    timeoutMs,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative path to an image file." },
        data: { type: "string", description: "Inline base64-encoded image data (alternative to path)." },
        mime: { type: "string", description: "MIME type for inline data, e.g. image/png (required with data)." },
        lang: { type: "string", description: "OCR language hint, e.g. eng (default eng)." },
        model: { type: "string", description: "Logical model id for the provider fallback." },
      },
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const lang = optString(o, "lang");
      const media = await loadMedia(o, ctx, "image");

      // 1. Injected OCR engine.
      if (deps.ocr) {
        try {
          const args: OcrArgs = { data: media.data, mime: media.mime };
          if (lang !== undefined) args.lang = lang;
          const r = await deps.ocr(args, ctx);
          return okText(cap(r.text, maxChars));
        } catch (err) {
          return errText(`ai_ocr: OCR engine failed: ${(err as Error).message}`);
        }
      }

      // 2. Optional-lazy tesseract.js.
      const mod = (await optionalImport("tesseract.js")) as TesseractModule | undefined;
      if (mod && typeof mod.recognize === "function") {
        try {
          const buf = Buffer.from(media.data, "base64");
          const out = await mod.recognize(buf, lang ?? "eng");
          return okText(cap(out.data?.text ?? "", maxChars));
        } catch (err) {
          return errText(`ai_ocr: tesseract.js failed: ${(err as Error).message}`);
        }
      }

      // 3. Vision provider fallback.
      if (deps.provider) {
        const model = optString(o, "model") ?? deps.model ?? "vision";
        const req: ChatRequest = {
          model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: OCR_PROMPT },
                { type: "image", mime: media.mime, data: media.data },
              ],
            },
          ],
        };
        try {
          const signal = timeoutSignal(ctx, timeoutMs);
          const text = await completeText(deps.provider, req, callContext(ctx, signal));
          return okText(cap(text, maxChars));
        } catch (err) {
          return errText(`ai_ocr: provider fallback failed: ${(err as Error).message}`);
        }
      }

      return errText(
        "ai_ocr: no OCR backend available (npm i tesseract.js, or inject an ocr engine / vision provider).",
      );
    },
  };
}
