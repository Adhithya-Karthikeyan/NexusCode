/**
 * EventProjector — the bridge from the runner's StreamChunks to typed deltas.
 *
 * Maintains a versioned chunk-type registry (StreamChunk `type` → handler that
 * returns Deltas). KNOWN types map to execution-event deltas; UNKNOWN types
 * NEVER silently skip — they emit an execution-event delta with
 * `result: "unknown"` and `rawType` set. `projectorVersion` is bumped whenever
 * the registry changes so replayed projections can be invalidated.
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

/** Create an EventProjector with the Phase 1 chunk-type registry. */
export function createEventProjector(): EventProjector {
  return {
    project(chunk, ctx): Delta[] {
      const handler = REGISTRY[chunk.type];
      if (handler) return handler(chunk, ctx);
      // UNKNOWN type — never silently skip.
      return [unknownDelta(chunk, ctx)];
    },
  };
}

/** A chunk handler. */
type ChunkHandler = (chunk: StreamChunk, ctx: ProjectionContext) => Delta[];

function execDelta(
  sessionId: string,
  lamportTs: number,
  action: string,
  result: EpisodicFields["result"],
  target: string | undefined,
  rawType: string | undefined,
  rawRef: string | undefined,
  title: string,
  body: string,
): Delta {
  const fields: EpisodicFields = {
    runId: "", // filled below
    turnId: "",
    action,
    result,
    projectorVersion: PROJECTOR_VERSION,
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
    sessionId,
    lamportTs,
    actionId: `${action}-${lamportTs}`,
    entityId: `${sessionId}-${lamportTs}-${action}`,
    title,
    body,
    fields: { ...fields, runId: "", turnId: "" },
  };
}

// Patch execDelta to also stamp runId/turnId — done inline below instead.
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
  "tool-call-start": (chunk, ctx) => {
    const c = chunk as Extract<StreamChunk, { type: "tool-call-start" }>;
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
  "tool-call-end": (chunk, ctx) => {
    const c = chunk as Extract<StreamChunk, { type: "tool-call-end" }>;
    return [
      makeExecDelta(
        ctx,
        c.name,
        "success",
        c.id,
        undefined,
        undefined,
        `Tool call: ${c.name}`,
        `Completed tool ${c.name} (call ${c.id})`,
      ),
    ];
  },
  "tool-result": (chunk, ctx) => {
    const c = chunk as Extract<StreamChunk, { type: "tool-result" }>;
    const result: EpisodicFields["result"] = c.isError ? "failure" : "success";
    return [
      makeExecDelta(
        ctx,
        "tool-result",
        result,
        c.toolCallId,
        undefined,
        undefined,
        `Tool result: ${c.toolCallId}`,
        `${c.isError ? "Errored" : "Succeeded"} tool call ${c.toolCallId}`,
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
  "text-delta": (_chunk, _ctx) => [], // scratch/working-memory — noop for Phase 1
  "reasoning-delta": (_chunk, _ctx) => [],
  "run-start": (_chunk, _ctx) => [],
  "session-init": (_chunk, _ctx) => [],
  "tool-call-delta": (_chunk, _ctx) => [],
  "file-edit": (_chunk, _ctx) => [],
  "approval-request": (_chunk, _ctx) => [],
  "usage": (_chunk, _ctx) => [],
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