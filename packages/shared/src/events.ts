/**
 * The definitive `StreamChunk` union — frozen contract. Every adapter, whether
 * an HTTP SDK or a wrapped coding CLI, translates its backend into exactly this
 * union. Guarantees: exactly one `run-start` first, exactly one terminal
 * (`run-end` or `error`) last. Every chunk carries `runId` (stamped by the
 * adapter from `ctx.runId`); the bus additionally stamps a monotonic `seq` on
 * publish (see `@nexuscode/core`'s `Labeled`).
 *
 * `file-edit`, `tool-result`, and `approval-request` are what make a wrapped
 * coding CLI a first-class citizen — chat providers simply never emit them.
 * Any chunk may carry an optional `raw` (untranslated provider event) so
 * features NexusCode has not modeled yet still survive to the audit log.
 */

import type { AdapterError } from "./errors.js";
import type { ContentBlock, Message } from "./messages.js";
import type { Usage } from "./usage.js";

export type FinishReason =
  | "stop"
  | "length"
  | "tool_use"
  | "content_filter"
  | "cancelled"
  | "error";

/** Optional passthrough of the untranslated provider event. */
export interface RawCarrier {
  raw?: unknown;
}

export type StreamChunk =
  | ({ type: "run-start"; runId: string; adapterId: string; model: string; ts: number } & RawCarrier)
  | ({ type: "session-init"; runId: string; providerSessionId?: string; tools?: string[]; mcpServers?: string[] } & RawCarrier)
  | ({ type: "text-delta"; runId: string; text: string; channel?: "answer" | "reasoning" } & RawCarrier)
  | ({ type: "reasoning-delta"; runId: string; text: string } & RawCarrier)
  | ({ type: "tool-call-start"; runId: string; id: string; name: string } & RawCarrier)
  | ({ type: "tool-call-delta"; runId: string; id: string; argsJsonDelta: string } & RawCarrier)
  | ({ type: "tool-call-end"; runId: string; id: string; input: unknown } & RawCarrier)
  | ({ type: "tool-result"; runId: string; toolCallId: string; content: ContentBlock[]; isError?: boolean } & RawCarrier)
  | ({ type: "file-edit"; runId: string; path: string; diff: string; status: "proposed" | "applied" | "cancelled"; approvalId?: string } & RawCarrier)
  | ({ type: "approval-request"; runId: string; approvalId: string; kind: "file" | "shell" | "tool"; detail: unknown } & RawCarrier)
  | ({ type: "usage"; runId: string; usage: Partial<Usage> } & RawCarrier)
  | ({ type: "run-end"; runId: string; finishReason: FinishReason; message: Message; usage?: Usage; providerSessionId?: string; ts: number } & RawCarrier)
  | ({ type: "error"; runId: string; error: AdapterError; retryable: boolean } & RawCarrier);

export type StreamChunkType = StreamChunk["type"];

/** The two non-content chunks that precede the first real output. */
export function isPreamble(chunk: StreamChunk): boolean {
  return chunk.type === "run-start" || chunk.type === "session-init";
}

/** A terminal chunk ends the stream. */
export function isTerminal(chunk: StreamChunk): chunk is Extract<StreamChunk, { type: "run-end" | "error" }> {
  return chunk.type === "run-end" || chunk.type === "error";
}
