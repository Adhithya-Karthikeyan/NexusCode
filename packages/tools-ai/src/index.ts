/**
 * @nexuscode/tools-ai — the AI tool group (system-spec §6, "AI" row).
 *
 * Four tools, each implementing the frozen `@nexuscode/tools` `Tool` contract
 * (name, description, JSON-Schema parameters, `permission: "network"`,
 * `timeoutMs`, `run` → `ToolResult`):
 *
 *   - `ai_vision`          — analyze an image via an injected vision provider.
 *   - `ai_ocr`             — extract text via an injected engine, optional
 *                            `tesseract.js`, or a vision provider fallback.
 *   - `ai_image_generate`  — synthesize images via an injected generator or the
 *                            optional `openai` Images API.
 *   - `ai_speech`          — TTS/STT via an injected engine or the optional
 *                            `openai` Audio API.
 *
 * Every real client library is an OPTIONAL, LAZILY-loaded dependency: absent
 * ⇒ a clear `isError` ToolResult with an install hint, never a crash. Media is
 * confined to the workspace; text output is capped; provider calls honor a
 * combined cancellation+timeout signal.
 */

export { createAiTools } from "./factory.js";
export { createAiVisionTool } from "./vision.js";
export { createAiOcrTool } from "./ocr.js";
export { createAiImageGenerateTool } from "./imagegen.js";
export { createAiSpeechTool } from "./speech.js";

export type {
  AiToolDeps,
  OcrFn,
  OcrArgs,
  OcrResult,
  ImageGenerator,
  ImageGenRequest,
  GeneratedImage,
  SpeechEngine,
  SynthesizeArgs,
  SynthesizedAudio,
  TranscribeArgs,
  TranscriptResult,
} from "./types.js";

export {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_IMAGES,
  mimeFromExt,
} from "./support.js";
