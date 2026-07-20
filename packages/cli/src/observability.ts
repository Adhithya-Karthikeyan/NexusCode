/**
 * CLI-side observability wiring. Turns the loaded `observability` config into a
 * live tracer + `EngineTracer` whose `emit` sink plugs straight into the engine
 * (`createEngine({ emit })` / `RunContext.emit`), plus the exporters that make a
 * run's spans queryable later:
 *
 *   - an in-process `TraceStore` (same-process HUD / usage trailer),
 *   - an `NdjsonFileExporter` (default) so a SEPARATE `nexus trace` process can
 *     read a prior run's span timeline back from disk, fully offline,
 *   - an OTLP/HTTP seam when an endpoint is configured (never hit offline).
 *
 * Everything degrades safely: `observability.enabled=false` (or `exporter:none`)
 * yields no `emit`, so the engine runs exactly as before.
 */

import { dirname, join } from "node:path";
import { nexusPaths, type NexusConfig } from "@nexuscode/config";
import type { TraceEvent } from "@nexuscode/core";
import {
  EngineTracer,
  NdjsonFileExporter,
  OtlpHttpExporter,
  Tracer,
  TraceStore,
  readNdjsonSpans,
  renderTimeline,
  type MetricsSnapshot,
  type SpanData,
  type SpanExporter,
} from "@nexuscode/observability";

export interface ObservabilityRuntime {
  /** Whether the engine should be instrumented (emit spans). */
  enabled: boolean;
  /** Sink to hand to `createEngine({ emit })`. Undefined when disabled. */
  emit?: (e: TraceEvent) => void;
  /** In-process span sink (for the same-process HUD / usage trailer). */
  store: TraceStore;
  /** Live metrics accumulator (tokens/cost/latency/TTFT) for the run. */
  metrics: () => MetricsSnapshot;
  /** Resolved NDJSON span file (where a cross-process `trace` view reads from). */
  filePath: string;
  /** Exporter mode actually in effect. */
  exporter: NexusConfig["observability"]["exporter"];
  /** Flush buffered exporters (OTLP). NDJSON is synchronous, so this is cheap. */
  flush: () => Promise<void>;
}

/**
 * Resolve the NDJSON trace file: explicit config → `NEXUS_TRACE_FILE` env →
 * a `traces.ndjson` sitting beside the history db (so a temp data dir keeps a
 * run's history and its spans together, which is what the tests rely on).
 */
export function traceFilePath(config: NexusConfig, env: NodeJS.ProcessEnv = process.env): string {
  if (config.observability.filePath) return config.observability.filePath;
  const fromEnv = env["NEXUS_TRACE_FILE"];
  if (fromEnv) return fromEnv;
  const historyDb = config.history.dbPath ?? nexusPaths().historyDb;
  return join(dirname(historyDb), "traces.ndjson");
}

/** Build the observability runtime for one CLI invocation from config. */
export function buildObservability(config: NexusConfig): ObservabilityRuntime {
  const store = new TraceStore();
  const filePath = traceFilePath(config);
  const exporter = config.observability.exporter;

  if (!config.observability.enabled || exporter === "none") {
    return {
      enabled: false,
      store,
      metrics: () => ({ counters: {}, histograms: {} }),
      filePath,
      exporter,
      flush: async () => {},
    };
  }

  const exporters: SpanExporter[] = [store];
  if (exporter === "file") {
    exporters.push(new NdjsonFileExporter(filePath));
  } else if (exporter === "otlp") {
    // Always keep the NDJSON file too so an offline `nexus trace` still works.
    exporters.push(new NdjsonFileExporter(filePath));
    if (config.observability.otlpEndpoint) {
      exporters.push(new OtlpHttpExporter({ endpoint: config.observability.otlpEndpoint }));
    }
  }
  // `memory` keeps only the in-process store (already in `exporters`).

  const tracer = new Tracer({ exporters });
  const engineTracer = new EngineTracer({ tracer });

  return {
    enabled: true,
    emit: engineTracer.emit,
    store,
    metrics: () => engineTracer.metrics.snapshot(),
    filePath,
    exporter,
    flush: async () => {
      await tracer.flush();
    },
  };
}

/** Load a run/session's spans back from the NDJSON file (cross-process view). */
export function loadTraceSpans(filePath: string): SpanData[] {
  return readNdjsonSpans(filePath);
}

export { renderTimeline, TraceStore, type SpanData, type MetricsSnapshot };
