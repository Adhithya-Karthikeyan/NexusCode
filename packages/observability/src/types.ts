/**
 * OpenTelemetry-*shaped* trace primitives (system-spec §19). We deliberately do
 * not depend on `@opentelemetry/*` or a native OTLP exporter: those pull heavy,
 * platform-fragile transitive deps for what NexusCode needs — a span with an id,
 * a parent, attributes, timed events, and a start/end. The shapes below mirror
 * the OTel data model closely enough that a real OTLP exporter can be bolted on
 * later (see {@link "./exporters".OtlpHttpExporter}) without changing producers.
 */

/** Coarse span category, mapped onto OTLP `span.kind`-adjacent semantics. */
export type SpanKind =
  | "run" // a provider call / model turn
  | "tool" // a single tool execution
  | "subprocess" // a wrapped-CLI / child-process invocation
  | "orchestration" // race/compare/failover primitives
  | "context" // context assembly (retrieval, packing)
  | "internal"; // anything else

export type SpanStatus = "unset" | "ok" | "error";

/** OTLP-style attribute value: primitive or a homogeneous primitive array. */
export type AttributeValue =
  | string
  | number
  | boolean
  | null
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

export type Attributes = Record<string, AttributeValue>;

/** A timestamped point-event recorded on a span (OTLP `span.events`). */
export interface SpanEvent {
  name: string;
  /** epoch ms */
  ts: number;
  attributes: Attributes;
}

/**
 * The immutable record an exporter receives. Attributes/events/status message
 * are already secret-redacted by the tracer before this crosses the seam.
 */
export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  /** epoch ms */
  startTime: number;
  /** epoch ms; absent while the span is still open */
  endTime?: number;
  /** endTime - startTime; absent while open */
  durationMs?: number;
  status: SpanStatus;
  statusMessage?: string;
  attributes: Attributes;
  events: SpanEvent[];
}

/** A live span handle. Mutations affect only the in-flight span until `end()`. */
export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly kind: SpanKind;
  readonly name: string;
  setAttribute(key: string, value: AttributeValue): this;
  setAttributes(attrs: Attributes): this;
  addEvent(name: string, attrs?: Attributes): this;
  setStatus(status: SpanStatus, message?: string): this;
  /** Convenience: mark error status and record an `exception` event. */
  recordException(err: unknown): this;
  /** Open a child span in the same trace, parented to this span. */
  child(name: string, kind?: SpanKind, attrs?: Attributes): Span;
  /** Finalize the span, dispatch it to exporters, and return its record. */
  end(endTime?: number): SpanData;
  /** True once {@link end} has been called. */
  readonly ended: boolean;
  /** A copy of the span's current state (open or closed). */
  snapshot(): SpanData;
}

/** Sink for finished spans. Implementations must never throw to the tracer. */
export interface SpanExporter {
  export(span: SpanData): void;
  /** Optional durability flush (files, network). */
  flush?(): void | Promise<void>;
  /** Optional teardown. */
  shutdown?(): void | Promise<void>;
}
