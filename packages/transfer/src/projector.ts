/**
 * EventProjector — the bridge from the runner's StreamChunks to typed deltas.
 *
 * Maintains a versioned chunk-type registry (StreamChunk `type` → handler that
 * returns Deltas). KNOWN types map to execution-event deltas; UNKNOWN types
 * NEVER silently skip — they emit an execution-event delta with
 * `result: "unknown"` and `rawType` set. `projectorVersion` is bumped whenever
 * the registry changes so replayed projections can be invalidated.
 *
 * One projector instance is created per run (by the TransferHandle). It keeps a
 * per-run `callId → toolName` map so that `tool-call-end` / `tool-result`
 * chunks — whose StreamChunk shapes carry only a call id, not the tool name —
 * still materialize execution-events named after the tool (recovered from the
 * preceding `tool-call-start`). Without this, a provider switch would see
 * anonymous "tool-call-end" items instead of "bash ended".
 */

import type { StreamChunk } from "@nexuscode/shared";
import type { Delta } from "./deltas.js";
import type { EpisodicFields } from "./items.js";

/** Bumped on every registry change. */
export const PROJECTOR_VERSION = 1;

/** Projection context supplied by the runner. */
export interface ProjectionContext {
  runId: string;
  turnId: string;
  lamportTs: number;
  projectorVersion: number;
}

/** The EventProjector surface. */
export interface EventProjector {
  project(chunk: StreamChunk, ctx: ProjectionContext): Delta[];
}

/** A chunk handler, closing over the per-run callId→toolName map. */
type ChunkHandler = (
  chunk: StreamChunk,
  ctx: ProjectionContext,
  callNames: Map<string, string>,
) => Delta[];

/** Create an EventProjector with the Phase 1 chunk-type registry. */
export function createEventProjector(): EventProjector {
  // Per-run map: tool call id → tool name, populated on tool-call-start.
  const callNames = new Map<string, string>();
  return {
    project(chunk, ctx): Delta[] {
      const handler = REGISTRY[chunk.type];
      if (handler) return handler(chunk, ctx, callNames);
      // UNKNOWN type — never silently skip.
      return [unknownDelta(chunk, ctx)];
    },
  };
}

function makeExecDelta(
  ctx: ProjectionContext,
  action: string,
  result: EpisodicFields["result"],
  target: string | undefined,
  rawType: string | undefined,
  rawRef: string | undefined,
  title: string,
  body: string,
): Delta {
  const fields: EpisodicFields = {
    runId: ctx.runId,
    turnId: ctx.turnId,
    action,
    result,
    projectorVersion: ctx.projectorVersion,
    deltaKids: { added: [], updated: [], invalidated: [] },
    deltaFiles: [],
    tokensIn: 0,
    tokensOut: 0,
  };
  if (target !== undefined) fields.target = target;
  if (rawType !== undefined) fields.rawType = rawType;
  if (rawRef !== undefined) fields.rawRef = rawRef;
  return {
    op: "execution-event",
    sessionId: ctx.runId,
    lamportTs: ctx.lamportTs,
    actionId: `${action}-${ctx.lamportTs}`,
    entityId: `${ctx.runId}-${ctx.lamportTs}-${action}`,
    title,
    body,
    fields,
  };
}

const REGISTRY: Record<string, ChunkHandler> = {
  "tool-call-start": (chunk, ctx, callNames) => {
    const c = chunk as Extract<StreamChunk, { type: "tool-call-start" }>;
    if (c.name) callNames.set(c.id, c.name);
    return [
      makeExecDelta(
        ctx,
        c.name,
        "in-progress",
        c.id,
        undefined,
        undefined,
        `Tool call: ${c.name}`,
        `Started tool ${c.name} (call ${c.id})`,
      ),
    ];
  },
  "tool-call-end": (chunk, ctx, callNames) => {
    const c = chunk as Extract<StreamChunk, { type: "tool-call-end" }>;
    const name = callNames.get(c.id) ?? "tool-call-end";
    return [
      makeExecDelta(
        ctx,
        name,
        "success",
        c.id,
        undefined,
        undefined,
        `Tool call end: ${name}`,
        `Completed tool ${name} (call ${c.id})`,
      ),
    ];
  },
  "tool-result": (chunk, ctx, callNames) => {
    const c = chunk as Extract<StreamChunk, { type: "tool-result" }>;
    const name = callNames.get(c.toolCallId) ?? "tool-result";
    const result: EpisodicFields["result"] = c.isError ? "failure" : "success";
    return [
      makeExecDelta(
        ctx,
        name,
        result,
        c.toolCallId,
        undefined,
        undefined,
        `Tool result: ${name}`,
        `${c.isError ? "Errored" : "Succeeded"} tool ${name} (call ${c.toolCallId})`,
      ),
    ];
  },
  "run-end": (chunk, ctx) => {
    const c = chunk as Extract<StreamChunk, { type: "run-end" }>;
    const result: EpisodicFields["result"] =
      c.finishReason === "error" ? "failure" : "success";
    return [
      makeExecDelta(
        ctx,
        "run-end",
        result,
        undefined,
        undefined,
        undefined,
        `Run ended: ${c.finishReason}`,
        `Run ${ctx.runId} ended with finishReason=${c.finishReason}`,
      ),
    ];
  },
  "text-delta": () => [], // scratch/working-memory — noop for Phase 1
  "reasoning-delta": () => [],
  "run-start": () => [],
  "session-init": () => [],
  "tool-call-delta": () => [],
  "file-edit": () => [],
  "approval-request": () => [],
  "usage": () => [],
  "error": (chunk, ctx) => {
    const c = chunk as Extract<StreamChunk, { type: "error" }>;
    return [
      makeExecDelta(
        ctx,
        "error",
        "failure",
        undefined,
        "error",
        undefined,
        `Run error`,
        `Error: ${JSON.stringify(c.error)} (retryable=${c.retryable})`,
      ),
    ];
  },
};

/** Emit a delta for an unknown chunk type — never silently skip. */
function unknownDelta(chunk: StreamChunk, ctx: ProjectionContext): Delta {
  return makeExecDelta(
    ctx,
    "unknown",
    "unknown",
    undefined,
    chunk.type,
    chunk.type,
    `Unknown chunk: ${chunk.type}`,
    `Unhandled StreamChunk type ${chunk.type}`,
  );
}