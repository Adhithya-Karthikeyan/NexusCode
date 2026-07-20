/**
 * Shared plumbing for the AI tools: workspace-confined media loading, MIME
 * inference, optional-lazy module loading, provider stream consumption, timeout
 * signals, and output caps.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { NexusError } from "@nexuscode/shared";
import type { ChatRequest, ContentBlock, StreamChunk } from "@nexuscode/shared";
import type { CallContext, ProviderAdapter } from "@nexuscode/core";
import { resolveInWorkspace } from "@nexuscode/tools";
import type { ToolContext } from "@nexuscode/tools";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_OUTPUT_CHARS = 1_000_000;
export const DEFAULT_MAX_IMAGES = 4;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".svg": "image/svg+xml",
};

const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".webm": "audio/webm",
};

/** Infer a MIME type from a file extension, falling back to a generic default. */
export function mimeFromExt(file: string, kind: "image" | "audio"): string {
  const ext = path.extname(file).toLowerCase();
  const table = kind === "image" ? IMAGE_MIME : AUDIO_MIME;
  return table[ext] ?? (kind === "image" ? "application/octet-stream" : "application/octet-stream");
}

/** Loaded media: base64 payload plus its MIME type. */
export interface LoadedMedia {
  data: string;
  mime: string;
}

/**
 * Resolve a media argument to `{ data (base64), mime }`. Accepts EITHER a
 * workspace-relative `path` (read + confined to the workspace root) OR an inline
 * base64 `data` blob. Throws `NexusError("invalid_argument")` when neither is
 * given or when a `data` blob omits its `mime`.
 */
export async function loadMedia(
  o: Record<string, unknown>,
  ctx: ToolContext,
  kind: "image" | "audio",
): Promise<LoadedMedia> {
  const p = o["path"];
  const data = o["data"];
  const mimeIn = o["mime"];
  if (typeof p === "string" && p.length > 0) {
    const abs = await resolveInWorkspace(ctx.cwd, p);
    const buf = await fs.readFile(abs);
    const mime = typeof mimeIn === "string" && mimeIn.length > 0 ? mimeIn : mimeFromExt(abs, kind);
    return { data: buf.toString("base64"), mime };
  }
  if (typeof data === "string" && data.length > 0) {
    if (typeof mimeIn !== "string" || mimeIn.length === 0) {
      throw new NexusError("invalid_argument", `"mime" is required when passing inline "data"`);
    }
    return { data, mime: mimeIn };
  }
  throw new NexusError("invalid_argument", `provide either a workspace "path" or inline base64 "data"`);
}

/**
 * Dynamically import an OPTIONAL module by a runtime (non-literal) specifier so
 * the compiler/bundler never tries to resolve or bundle it. Returns `undefined`
 * when the package is not installed, so callers can degrade gracefully.
 */
export async function optionalImport(spec: string): Promise<unknown | undefined> {
  try {
    // The specifier is a variable, not a string literal: tsc/esbuild leave it
    // as a runtime import, so a missing optional dep is a caught error, not a
    // build failure.
    const dynamicImport = new Function("s", "return import(s);") as (s: string) => Promise<unknown>;
    return await dynamicImport(spec);
  } catch {
    return undefined;
  }
}

/** A signal that aborts on either the caller's cancellation or a timeout. */
export function timeoutSignal(ctx: ToolContext, ms: number): AbortSignal {
  return AbortSignal.any([ctx.signal, AbortSignal.timeout(ms)]);
}

/** Build a provider `CallContext` from a tool context + a (possibly combined) signal. */
export function callContext(ctx: ToolContext, signal: AbortSignal): CallContext {
  const base: CallContext = {
    signal,
    idempotencyKey: `ai_${randomUUID()}`,
    traceId: ctx.traceId ?? `ai_${randomUUID()}`,
    runId: ctx.runId ?? `ai_${randomUUID()}`,
  };
  return base;
}

/**
 * Consume a provider's streaming seam, accumulating answer text. A terminal
 * `error` chunk throws its `AdapterError`; reasoning deltas are ignored.
 */
export async function completeText(
  provider: ProviderAdapter,
  req: ChatRequest,
  ctx: CallContext,
): Promise<string> {
  let text = "";
  for await (const chunk of provider.stream(req, ctx) as AsyncIterable<StreamChunk>) {
    if (chunk.type === "text-delta") {
      if (chunk.channel === "reasoning") continue;
      text += chunk.text;
    } else if (chunk.type === "error") {
      throw chunk.error;
    }
  }
  return text;
}

/** Truncate `text` to `max` characters, appending a clear notice when cut. */
export function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated at ${max} characters]`;
}

/** A text content block. */
export function textBlock(text: string): ContentBlock {
  return { type: "text", text };
}
