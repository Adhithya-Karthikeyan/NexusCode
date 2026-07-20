/**
 * `ai_image_generate` — synthesize images from a text prompt.
 *
 * Resolution order:
 *   1. An injected `imageGenerator` (a fake in tests).
 *   2. The optional-lazy `openai` package (Images API), if installed + keyed.
 * When neither is available the tool returns a clear `isError` result with an
 * install hint. The result carries a text summary plus one `image` content
 * block per generated image. Permission class: `network`.
 */

import type { ContentBlock } from "@nexuscode/shared";
import { errText } from "@nexuscode/tools";
import type { Tool, ToolContext, ToolResult } from "@nexuscode/tools";
import type { AiToolDeps, GeneratedImage, ImageGenRequest } from "./types.js";
import { DEFAULT_MAX_IMAGES, optionalImport, textBlock } from "./support.js";
import { asObject, optNumber, optString, reqString } from "./validate.js";

interface OpenAiImagesModule {
  default?: new (opts?: unknown) => {
    images: {
      generate: (params: unknown) => Promise<{ data?: Array<{ b64_json?: string }> }>;
    };
  };
}

function imagesResult(prompt: string, images: GeneratedImage[], max: number): ToolResult {
  const clipped = images.slice(0, max);
  const content: ContentBlock[] = [
    textBlock(`Generated ${clipped.length} image(s) for prompt: "${prompt}".`),
  ];
  for (const img of clipped) {
    content.push({ type: "image", mime: img.mime, data: img.data });
  }
  return { ok: true, content };
}

export function createAiImageGenerateTool(deps: AiToolDeps): Tool {
  const maxImages = deps.maxImages ?? DEFAULT_MAX_IMAGES;
  return {
    name: "ai_image_generate",
    description:
      "Generate one or more images from a text prompt via an injected image generator or the optional openai Images API. Returns image content blocks.",
    permission: "network",
    timeoutMs: deps.timeoutMs ?? 60_000,
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the image(s) to generate." },
        size: { type: "string", description: "Image size, e.g. 1024x1024 (backend-specific)." },
        count: { type: "number", description: "Number of images to generate (clamped)." },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const o = asObject(input);
      const prompt = reqString(o, "prompt");
      const size = optString(o, "size");
      const count = Math.max(1, Math.min(maxImages, Math.trunc(optNumber(o, "count") ?? 1)));
      const req: ImageGenRequest = { prompt, count };
      if (size !== undefined) req.size = size;

      // 1. Injected generator.
      if (deps.imageGenerator) {
        try {
          const images = await deps.imageGenerator(req, ctx);
          return imagesResult(prompt, images, maxImages);
        } catch (err) {
          return errText(`ai_image_generate: generator failed: ${(err as Error).message}`);
        }
      }

      // 2. Optional-lazy openai Images API.
      const mod = (await optionalImport("openai")) as OpenAiImagesModule | undefined;
      const OpenAI = mod?.default;
      if (OpenAI) {
        try {
          const client = new OpenAI();
          const res = await client.images.generate({
            prompt,
            n: count,
            ...(size ? { size } : {}),
            response_format: "b64_json",
          });
          const images: GeneratedImage[] = (res.data ?? [])
            .filter((d): d is { b64_json: string } => typeof d.b64_json === "string")
            .map((d) => ({ mime: "image/png", data: d.b64_json }));
          if (images.length === 0) {
            return errText("ai_image_generate: provider returned no image data.");
          }
          return imagesResult(prompt, images, maxImages);
        } catch (err) {
          return errText(`ai_image_generate: openai call failed: ${(err as Error).message}`);
        }
      }

      return errText(
        "ai_image_generate: no image backend available (npm i openai, or inject an imageGenerator).",
      );
    },
  };
}
