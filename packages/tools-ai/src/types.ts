/**
 * Injected dependencies and payload types for the AI tool group.
 *
 * Every AI tool routes through EITHER an injected `ProviderAdapter` (the mock
 * in tests, a real vision/speech provider in production) OR an injected engine
 * function that a test can fake and production can back with an optional-lazy
 * client library (`tesseract.js`, `openai`, …). Nothing here is a hard
 * dependency: when neither an injected engine nor its optional library is
 * present, the tool returns a clear `isError` result instead of crashing.
 */

import type { ProviderAdapter } from "@nexuscode/core";
import type { ToolContext } from "@nexuscode/tools";

/** Result of an OCR pass. */
export interface OcrResult {
  text: string;
  /** Optional mean confidence in [0,1]. */
  confidence?: number;
}

/** Arguments handed to an injected OCR engine. `data` is base64. */
export interface OcrArgs {
  data: string;
  mime: string;
  lang?: string;
}

/** An injected OCR engine (a fake in tests; `tesseract.js` in production). */
export type OcrFn = (args: OcrArgs, ctx: ToolContext) => Promise<OcrResult>;

/** A request to generate one or more images from a text prompt. */
export interface ImageGenRequest {
  prompt: string;
  /** e.g. "1024x1024". Backend-specific; forwarded verbatim. */
  size?: string;
  /** Number of images to produce (clamped by the tool). */
  count?: number;
}

/** A single generated image; `data` is base64. */
export interface GeneratedImage {
  mime: string;
  data: string;
}

/** An injected image generator (a fake in tests; `openai` images in production). */
export type ImageGenerator = (
  req: ImageGenRequest,
  ctx: ToolContext,
) => Promise<GeneratedImage[]>;

/** Arguments for text-to-speech synthesis. */
export interface SynthesizeArgs {
  text: string;
  voice?: string;
  /** Output container/codec, e.g. "mp3" | "wav". Backend-specific. */
  format?: string;
}

/** A single synthesized audio clip; `data` is base64. */
export interface SynthesizedAudio {
  mime: string;
  data: string;
}

/** Arguments for speech-to-text transcription. `data` is base64 audio. */
export interface TranscribeArgs {
  data: string;
  mime: string;
  lang?: string;
}

/** Result of a transcription pass. */
export interface TranscriptResult {
  text: string;
}

/** An injected speech engine — either or both directions may be present. */
export interface SpeechEngine {
  synthesize?: (args: SynthesizeArgs, ctx: ToolContext) => Promise<SynthesizedAudio>;
  transcribe?: (args: TranscribeArgs, ctx: ToolContext) => Promise<TranscriptResult>;
}

/**
 * Dependencies for the AI tool group. All optional: each tool degrades
 * gracefully when its backing provider/engine/library is absent.
 */
export interface AiToolDeps {
  /**
   * Vision / analysis provider. Used by `ai_vision` (required there), and as a
   * fallback OCR engine by `ai_ocr` when no dedicated OCR engine is available.
   * In tests this is the offline mock adapter.
   */
  provider?: ProviderAdapter;
  /** Default logical model id requested from `provider`. */
  model?: string;
  /** Injected OCR engine. Overrides the optional-lazy `tesseract.js` path. */
  ocr?: OcrFn;
  /** Injected image generator. Overrides the optional-lazy `openai` path. */
  imageGenerator?: ImageGenerator;
  /** Injected speech engine. Overrides the optional-lazy `openai` path. */
  speech?: SpeechEngine;
  /** Wall-clock budget per call (ms). Default 60000. */
  timeoutMs?: number;
  /** Max characters of text returned before truncation. Default 1_000_000. */
  maxOutputChars?: number;
  /** Max images returned by `ai_image_generate`. Default 4. */
  maxImages?: number;
}
