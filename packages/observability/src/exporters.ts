/**
 * Span exporters (system-spec §19):
 *  - {@link InMemoryExporter}: keeps spans in an array — for tests and an
 *    in-process trace view.
 *  - {@link NdjsonFileExporter}: appends one JSON span per line under a data
 *    dir; round-trips via {@link readNdjsonSpans}. No network, no native deps.
 *  - {@link OtlpHttpExporter}: an OTLP/HTTP *seam*. It buffers spans and, on
 *    flush, POSTs a minimal OTLP-JSON envelope through an injected `fetch`. It
 *    is never exercised by the offline test suite.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SpanData, SpanExporter } from "./types.js";

/** Collects finished spans in memory. Cheap, synchronous, test-friendly. */
export class InMemoryExporter implements SpanExporter {
  private readonly spans: SpanData[] = [];

  export(span: SpanData): void {
    this.spans.push(span);
  }

  /** All exported spans, in export order. */
  getSpans(): readonly SpanData[] {
    return this.spans;
  }

  /** Spans belonging to one trace, in start-time order. */
  getTrace(traceId: string): SpanData[] {
    return this.spans.filter((s) => s.traceId === traceId).sort((a, b) => a.startTime - b.startTime);
  }

  reset(): void {
    this.spans.length = 0;
  }
}

/** Serialize one span to a single NDJSON line (no trailing newline). */
export function spanToNdjsonLine(span: SpanData): string {
  return JSON.stringify(span);
}

/** Read an NDJSON span file back into records (skips blank lines). */
export function readNdjsonSpans(filePath: string): SpanData[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const out: SpanData[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as SpanData);
    } catch {
      /* skip a corrupt line rather than fail the whole read */
    }
  }
  return out;
}

/**
 * Appends finished spans as NDJSON to `filePath`. The parent directory is
 * created (mode 0700) on first write; the file is chmod-restricted best-effort
 * elsewhere. Writes are synchronous appends so an abrupt exit still leaves a
 * complete, replayable prefix.
 */
export class NdjsonFileExporter implements SpanExporter {
  private ensured = false;

  constructor(private readonly filePath: string) {}

  private ensureDir(): void {
    if (this.ensured) return;
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    } catch {
      /* directory may already exist / be unwritable — append will surface it */
    }
    this.ensured = true;
  }

  export(span: SpanData): void {
    this.ensureDir();
    try {
      appendFileSync(this.filePath, `${spanToNdjsonLine(span)}\n`, { mode: 0o600 });
    } catch {
      /* a trace sink must never break the traced operation */
    }
  }

  /** Load everything written so far (round-trips {@link export}). */
  read(): SpanData[] {
    return readNdjsonSpans(this.filePath);
  }
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface OtlpHttpExporterOptions {
  /** OTLP/HTTP traces endpoint, e.g. http://localhost:4318/v1/traces */
  endpoint: string;
  headers?: Record<string, string>;
  /** Injected transport; defaults to global fetch. Left as a seam for tests. */
  fetchImpl?: FetchLike;
}

/**
 * OTLP/HTTP exporter *seam*. Buffers spans and, on {@link flush}, POSTs a
 * minimal OTLP-JSON `resourceSpans` envelope. This exists so a deployment can
 * point NexusCode at a collector without changing any producer; the offline
 * suite never calls flush (no network), and no OTLP native library is required.
 */
export class OtlpHttpExporter implements SpanExporter {
  private buffer: SpanData[] = [];
  private readonly endpoint: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike | undefined;

  constructor(opts: OtlpHttpExporterOptions) {
    this.endpoint = opts.endpoint;
    this.headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
    this.fetchImpl = opts.fetchImpl;
  }

  export(span: SpanData): void {
    this.buffer.push(span);
  }

  /** Spans awaiting flush (visible for assertions without hitting the network). */
  pending(): readonly SpanData[] {
    return this.buffer;
  }

  private envelope(spans: SpanData[]): unknown {
    const toNano = (ms: number) => String(Math.round(ms * 1_000_000));
    return {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: "nexuscode" } }] },
          scopeSpans: [
            {
              scope: { name: "@nexuscode/observability" },
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: s.name,
                startTimeUnixNano: toNano(s.startTime),
                ...(s.endTime !== undefined ? { endTimeUnixNano: toNano(s.endTime) } : {}),
                attributes: Object.entries(s.attributes).map(([key, value]) => ({
                  key,
                  value: { stringValue: String(value) },
                })),
                status: { code: s.status === "error" ? 2 : s.status === "ok" ? 1 : 0 },
              })),
            },
          ],
        },
      ],
    };
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const impl = this.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!impl) return; // no transport available: keep buffering (seam is inert)
    const batch = this.buffer;
    this.buffer = [];
    try {
      await impl(this.endpoint, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify(this.envelope(batch)),
      });
    } catch {
      // on failure, re-buffer so the next flush retries rather than dropping
      this.buffer = batch.concat(this.buffer);
    }
  }
}
