/**
 * `ai_vision` — analyze an image with a vision-capable provider.
 *
 * Loads an image (workspace path or inline base64), attaches it to a chat
 * request alongside a text prompt, and consumes the injected provider's
 * streaming seam. The provider is injected (the offline mock in tests). When no
 * provider is configured, the tool returns a clear `isError` result rather than
 * crashing. Permission class: `network`.
 */

import type { ChatRequest } from "@nexuscode/shared";
import { errText, okText } from "@nexuscode/tools";
import type { Tool, ToolContext, ToolResult } from "@nexuscode/tools";
import type { AiToolDeps } from "./types.js";
import {
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_TIMEOUT_MS,
  callContext,
  cap,
  completeText,
  loadMedia,
  timeoutSignal,
} from "./support.js";
import { asObject, optString } from "./validate.js";

const DEFAULT_PROMPT = "Describe this image in detail.";

export function createAiVisionTool(deps: AiToolDeps): Tool {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = deps.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  return {
    name: "ai_vision",
    description:
      "Analyze an image with a vision-capable AI provider and return a textual description or answer. Accepts a workspace image path or inline base64 data.",
    permission: "network",
    timeoutMs,
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Question or instruction about the image (default: describe it)." },
        path: { type: "string", description: "Workspace-relative path to an image file." },
        data: { type: "string", description: "Inline base64-encoded image data (alternative to path)." },
        mime: { type: "string", description: "MIME type for inline data, e.g. image/png (required with data)." },
        model: { type: "string", description: "Logical model id to request." },
      },
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const prompt = optString(o, "prompt") ?? DEFAULT_PROMPT;
      const model = optString(o, "model") ?? deps.model ?? "vision";
      if (!deps.provider) {
        return errText("ai_vision: no provider configured (inject a vision-capable ProviderAdapter).");
      }
      const media = await loadMedia(o, ctx, "image");
      const req: ChatRequest = {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
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
        return errText(`ai_vision: provider call failed: ${(err as Error).message}`);
      }
    },
  };
}
