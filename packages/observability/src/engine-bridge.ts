/**
 * The seam that connects the engine to the tracer. The core kernel emits
 * discrete `TraceEvent`s through `CallContext.emit` (see
 * `@nexuscode/core` `adapter.ts`); this bridge reconstructs a span tree from
 * them and folds usage/errors into metrics. It is decoupled from core on
 * purpose — the local {@link TraceEvent} is structurally identical to core's, so
 * `callCtx.emit = engineTracer.emit` type-checks without importing the kernel.
 *
 * Protocol: a producer brackets an operation with a `start` and an `end` event
 * carrying a `spanKey`; the bridge keeps a per-trace stack so a `tool` started
 * inside a `run` nests under it, and a `subprocess` inside a `tool` nests under
 * that. Non-bracketed events attach to the current span as timed events; error-
 * typed events also bump the error counter. Build these events with the
 * {@link spanStartEvent}/{@link spanEndEvent} helpers.
 */

import type { Usage } from "@nexuscode/shared";
import { RunMetrics } from "./metrics.js";
import { Tracer } from "./tracer.js";
import type { Attributes, Span, SpanKind, SpanStatus } from "./types.js";

/** Structural mirror of `@nexuscode/core` `TraceEvent` (kept dep-free). */
export interface TraceEvent {
  type: string;
  traceId: string;
  runId?: string;
  ts: number;
  data?: unknown;
}

/** `data` payload the bridge understands on a span-lifecycle event. */
export interface SpanLifecycleData {
  phase: "start" | "end" | "first-token";
  /** Unique-per-open-span key within a trace (e.g. runId, `tool:<callId>`). */
  spanKey: string;
  name?: string;
  kind?: SpanKind;
  attributes?: Attributes;
  status?: SpanStatus;
  message?: string;
  usage?: Usage;
}

const KIND_BY_PREFIX: { prefix: string; kind: SpanKind }[] = [
  { prefix: "tool:", kind: "tool" },
  { prefix: "subprocess:", kind: "subprocess" },
  { prefix: "cli:", kind: "subprocess" },
  { prefix: "orchestrate:", kind: "orchestration" },
  { prefix: "context:", kind: "context" },
  { prefix: "run", kind: "run" },
];

function inferKind(spanKey: string, explicit?: SpanKind): SpanKind {
  if (explicit) return explicit;
  for (const { prefix, kind } of KIND_BY_PREFIX) {
    if (spanKey.startsWith(prefix)) return kind;
  }
  return "internal";
}

function asLifecycle(data: unknown): SpanLifecycleData | undefined {
  if (data && typeof data === "object" && "phase" in data && "spanKey" in data) {
    return data as SpanLifecycleData;
  }
  return undefined;
}

interface OpenSpan {
  spanKey: string;
  span: Span;
}

export interface EngineTracerOptions {
  tracer: Tracer;
  metrics?: RunMetrics;
}

/**
 * Turns `TraceEvent`s into spans + metrics. Attach `engineTracer.emit` to
 * `CallContext.emit`. Thread-safe for the single-threaded event loop: one
 * open-span stack per traceId.
 */
export class EngineTracer {
  readonly tracer: Tracer;
  readonly metrics: RunMetrics;
  /** traceId -> stack of currently-open spans (innermost last). */
  private readonly stacks = new Map<string, OpenSpan[]>();

  constructor(opts: EngineTracerOptions) {
    this.tracer = opts.tracer;
    this.metrics = opts.metrics ?? new RunMetrics();
    this.emit = this.emit.bind(this);
  }

  private stackFor(traceId: string): OpenSpan[] {
    let s = this.stacks.get(traceId);
    if (!s) {
      s = [];
      this.stacks.set(traceId, s);
    }
    return s;
  }

  /** Sink assignable to `CallContext.emit`. */
  emit(e: TraceEvent): void {
    const lifecycle = asLifecycle(e.data);
    if (lifecycle?.phase === "start") return void this.onStart(e, lifecycle);
    if (lifecycle?.phase === "end") return void this.onEnd(e, lifecycle);
    if (lifecycle?.phase === "first-token") return void this.onFirstToken(e, lifecycle);
    this.onPoint(e);
  }

  private onStart(e: TraceEvent, l: SpanLifecycleData): void {
    const stack = this.stackFor(e.traceId);
    const parent = stack.length ? stack[stack.length - 1]?.span : undefined;
    const kind = inferKind(l.spanKey, l.kind);
    const attributes: Attributes = { ...(l.attributes ?? {}) };
    if (e.runId) attributes["nexus.run_id"] = e.runId;
    const span = this.tracer.startSpan(l.name ?? l.spanKey, {
      kind,
      startTime: e.ts,
      attributes,
      ...(parent ? { parent } : { traceId: e.traceId }),
    });
    stack.push({ spanKey: l.spanKey, span });
  }

  private onEnd(e: TraceEvent, l: SpanLifecycleData): void {
    const stack = this.stackFor(e.traceId);
    const idx = stack.map((o) => o.spanKey).lastIndexOf(l.spanKey);
    if (idx === -1) return; // unmatched end — ignore rather than fabricate
    const open = stack[idx] as OpenSpan;
    stack.splice(idx, 1);
    const span = open.span;
    if (l.attributes) span.setAttributes(l.attributes);

    if (l.usage) {
      const labels = { kind: span.kind, ...(e.runId ? { run: e.runId } : {}) };
      this.metrics.recordUsage(l.usage, labels);
      this.applyUsageAttributes(span, l.usage);
    }

    const durationMs = e.ts - span.snapshot().startTime;
    const labels = { kind: span.kind };
    if (span.kind === "run") this.metrics.latency(durationMs, labels);
    if (span.kind === "tool" || span.kind === "subprocess") this.metrics.toolExec(durationMs, labels);

    if (l.status === "error") {
      this.metrics.error({ kind: span.kind });
      span.setStatus("error", l.message);
    } else if (l.status) {
      span.setStatus(l.status, l.message);
    }
    span.end(e.ts);
  }

  private onFirstToken(e: TraceEvent, l: SpanLifecycleData): void {
    const stack = this.stackFor(e.traceId);
    const open = stack.map((o) => o.spanKey).lastIndexOf(l.spanKey);
    const target = open !== -1 ? (stack[open] as OpenSpan).span : stack[stack.length - 1]?.span;
    if (!target) return;
    const ttft = e.ts - target.snapshot().startTime;
    target.setAttribute("nexus.ttft_ms", ttft);
    target.addEvent("first-token", { ttft_ms: ttft });
    this.metrics.ttft(ttft, { kind: target.kind });
  }

  private onPoint(e: TraceEvent): void {
    const stack = this.stackFor(e.traceId);
    const active = stack[stack.length - 1]?.span;
    const attrs: Attributes = e.data !== undefined ? { data: safeString(e.data) } : {};
    const isError = /error|fail/i.test(e.type);
    if (isError) this.metrics.error({ type: e.type });
    if (active) {
      active.addEvent(e.type, attrs);
      if (isError) active.setStatus("error", e.type);
      return;
    }
    // No open span: record a zero-duration marker span so the event stays queryable.
    const span = this.tracer.startSpan(e.type, {
      kind: "internal",
      traceId: e.traceId,
      startTime: e.ts,
      attributes: attrs,
    });
    if (isError) span.setStatus("error", e.type);
    span.end(e.ts);
  }

  private applyUsageAttributes(span: Span, usage: Usage): void {
    // NB: attribute keys deliberately avoid the substrings "token"/"key"/… —
    // the secret-redaction pass masks any such key's value, which would wipe
    // these legitimate counts. Metric *names* (see MetricName) are exempt: they
    // never pass through attribute redaction.
    span.setAttribute("nexus.usage.input", usage.inputTokens);
    span.setAttribute("nexus.usage.output", usage.outputTokens);
    if (usage.cacheReadTokens) span.setAttribute("nexus.usage.cache_read", usage.cacheReadTokens);
    if (usage.cacheWriteTokens) span.setAttribute("nexus.usage.cache_write", usage.cacheWriteTokens);
    const cost = usage.costUsd ?? usage.reportedCostUsd;
    if (cost != null) span.setAttribute("nexus.cost_usd", cost);
  }
}

function safeString(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** Build a well-formed span-start `TraceEvent`. */
export function spanStartEvent(
  traceId: string,
  spanKey: string,
  opts: { name?: string; kind?: SpanKind; attributes?: Attributes; runId?: string; ts?: number } = {},
): TraceEvent {
  const data: SpanLifecycleData = { phase: "start", spanKey };
  if (opts.name !== undefined) data.name = opts.name;
  if (opts.kind !== undefined) data.kind = opts.kind;
  if (opts.attributes !== undefined) data.attributes = opts.attributes;
  const e: TraceEvent = { type: "span.start", traceId, ts: opts.ts ?? Date.now(), data };
  if (opts.runId !== undefined) e.runId = opts.runId;
  return e;
}

/** Build a well-formed span-end `TraceEvent`. */
export function spanEndEvent(
  traceId: string,
  spanKey: string,
  opts: {
    status?: SpanStatus;
    message?: string;
    attributes?: Attributes;
    usage?: Usage;
    runId?: string;
    ts?: number;
  } = {},
): TraceEvent {
  const data: SpanLifecycleData = { phase: "end", spanKey };
  if (opts.status !== undefined) data.status = opts.status;
  if (opts.message !== undefined) data.message = opts.message;
  if (opts.attributes !== undefined) data.attributes = opts.attributes;
  if (opts.usage !== undefined) data.usage = opts.usage;
  const e: TraceEvent = { type: "span.end", traceId, ts: opts.ts ?? Date.now(), data };
  if (opts.runId !== undefined) e.runId = opts.runId;
  return e;
}

/** Build a first-token `TraceEvent` (for TTFT). */
export function firstTokenEvent(
  traceId: string,
  spanKey: string,
  opts: { runId?: string; ts?: number } = {},
): TraceEvent {
  const data: SpanLifecycleData = { phase: "first-token", spanKey };
  const e: TraceEvent = { type: "span.first-token", traceId, ts: opts.ts ?? Date.now(), data };
  if (opts.runId !== undefined) e.runId = opts.runId;
  return e;
}
