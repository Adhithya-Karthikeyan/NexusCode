/**
 * Group factory: build every AI tool from one set of injected dependencies so
 * integration code can register the group in a single call.
 */

import type { Tool } from "@nexuscode/tools";
import type { AiToolDeps } from "./types.js";
import { createAiVisionTool } from "./vision.js";
import { createAiOcrTool } from "./ocr.js";
import { createAiImageGenerateTool } from "./imagegen.js";
import { createAiSpeechTool } from "./speech.js";

/** Return the AI tool group (`ai_vision`, `ai_ocr`, `ai_image_generate`, `ai_speech`). */
export function createAiTools(deps: AiToolDeps = {}): Tool[] {
  return [
    createAiVisionTool(deps),
    createAiOcrTool(deps),
    createAiImageGenerateTool(deps),
    createAiSpeechTool(deps),
  ];
}
