/**
 * @nexuscode/observability — the observability subsystem (system-spec §19).
 *
 * An OpenTelemetry-*shaped* tracer (spans with trace/span ids, parent/child
 * nesting, attributes, timed events, start/end) plus token/cost/latency/TTFT/
 * tool/error metrics, three exporters (InMemory, NDJSON-file, and an OTLP/HTTP
 * seam), and a TraceStore/timeline query for a CLI trace view. Deliberately
 * free of native telemetry deps so it runs anywhere the CLI does.
 *
 * Plug it into the engine by wiring an {@link EngineTracer} to
 * `CallContext.emit` (see `@nexuscode/core` `adapter.ts`):
 *
 *   const tracer = new Tracer({ exporters: [store, new NdjsonFileExporter(p)] });
 *   const engineTracer = new EngineTracer({ tracer });
 *   callCtx.emit = engineTracer.emit;
 *
 * Secrets are redacted from every span before it reaches an exporter, reusing
 * the same pass as tool-argument/history redaction.
 */

export type {
  AttributeValue,
  Attributes,
  Span,
  SpanData,
  SpanEvent,
  SpanExporter,
  SpanKind,
  SpanStatus,
} from "./types.js";

export { Tracer } from "./tracer.js";
export type { TracerOptions, StartSpanOptions } from "./tracer.js";

export {
  cryptoIdGenerator,
  sequentialIdGenerator,
} from "./ids.js";
export type { IdGenerator } from "./ids.js";

export { redactAttributes, redactMessage, redactSpanData } from "./redact.js";

export { Metrics, RunMetrics, MetricName } from "./metrics.js";
export type {
  Counter,
  Histogram,
  Labels,
  CounterSnapshot,
  HistogramSnapshot,
  MetricsSnapshot,
} from "./metrics.js";

export {
  InMemoryExporter,
  NdjsonFileExporter,
  OtlpHttpExporter,
  readNdjsonSpans,
  spanToNdjsonLine,
} from "./exporters.js";
export type { FetchLike, OtlpHttpExporterOptions } from "./exporters.js";

export { TraceStore, renderTimeline } from "./store.js";
export type { TimelineRow, TraceNode } from "./store.js";

export {
  EngineTracer,
  spanStartEvent,
  spanEndEvent,
  firstTokenEvent,
} from "./engine-bridge.js";
export type {
  TraceEvent,
  SpanLifecycleData,
  EngineTracerOptions,
} from "./engine-bridge.js";
