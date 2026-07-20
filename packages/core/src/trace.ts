/**
 * Engine-side span instrumentation helpers. The kernel brackets each operation
 * (run / tool / subprocess / orchestration / context) with a `span.start` and a
 * `span.end` `TraceEvent` emitted through `CallContext.emit` / `RunContext.emit`.
 * A consumer (the `EngineTracer` in `@nexuscode/observability`) reconstructs a
 * span tree from these events — but core stays dependency-free: the lifecycle
 * `data` payload is a plain structural object the bridge reads by shape, so this
 * module never imports the observability package.
 *
 * The payload shape mirrors `@nexuscode/observability`'s `SpanLifecycleData`
 * exactly: `{ phase, spanKey, name?, kind?, attributes?, status?, message?,
 * usage? }`. Keep the two in sync (additive-only).
 */

import type { Usage } from "@nexuscode/shared";
import type { TraceEvent } from "./adapter.js";

/** Span kinds the engine emits (matches the observability bridge's union). */
export type EngineSpanKind =
  | "run"
  | "tool"
  | "subprocess"
  | "orchestration"
  | "context"
  | "internal";

export type EngineSpanStatus = "ok" | "error" | "cancelled" | "unset";

/** Attribute value shape accepted on a span (kept structural / dep-free). */
export type SpanAttributes = Record<string, string | number | boolean>;

interface SpanStartOpts {
  name?: string;
  kind?: EngineSpanKind;
  attributes?: SpanAttributes;
  runId?: string;
  ts?: number;
}

interface SpanEndOpts {
  status?: EngineSpanStatus;
  message?: string;
  attributes?: SpanAttributes;
  usage?: Usage;
  runId?: string;
  ts?: number;
}

/** Build a `span.start` `TraceEvent`. */
export function spanStart(traceId: string, spanKey: string, opts: SpanStartOpts = {}): TraceEvent {
  const data: Record<string, unknown> = { phase: "start", spanKey };
  if (opts.name !== undefined) data.name = opts.name;
  if (opts.kind !== undefined) data.kind = opts.kind;
  if (opts.attributes !== undefined) data.attributes = opts.attributes;
  const e: TraceEvent = { type: "span.start", traceId, ts: opts.ts ?? Date.now(), data };
  if (opts.runId !== undefined) e.runId = opts.runId;
  return e;
}

/** Build a `span.end` `TraceEvent`. */
export function spanEnd(traceId: string, spanKey: string, opts: SpanEndOpts = {}): TraceEvent {
  const data: Record<string, unknown> = { phase: "end", spanKey };
  if (opts.status !== undefined) data.status = opts.status;
  if (opts.message !== undefined) data.message = opts.message;
  if (opts.attributes !== undefined) data.attributes = opts.attributes;
  if (opts.usage !== undefined) data.usage = opts.usage;
  const e: TraceEvent = { type: "span.end", traceId, ts: opts.ts ?? Date.now(), data };
  if (opts.runId !== undefined) e.runId = opts.runId;
  return e;
}

/** Build a `span.first-token` `TraceEvent` (drives TTFT). */
export function spanFirstToken(
  traceId: string,
  spanKey: string,
  opts: { runId?: string; ts?: number } = {},
): TraceEvent {
  const data: Record<string, unknown> = { phase: "first-token", spanKey };
  const e: TraceEvent = { type: "span.first-token", traceId, ts: opts.ts ?? Date.now(), data };
  if (opts.runId !== undefined) e.runId = opts.runId;
  return e;
}
