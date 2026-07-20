/**
 * The tracer: creates spans, threads parent/child relationships, and dispatches
 * finished spans (redacted) to every registered exporter. Kept dependency-free
 * beyond id generation + redaction so it can run in the CLI, a test, or the
 * engine without pulling native telemetry libraries.
 */

import { cryptoIdGenerator, type IdGenerator } from "./ids.js";
import { redactSpanData } from "./redact.js";
import type {
  AttributeValue,
  Attributes,
  Span,
  SpanData,
  SpanEvent,
  SpanExporter,
  SpanKind,
} from "./types.js";

export interface TracerOptions {
  /** Where finished spans go. May be empty (spans are still queryable via handles). */
  exporters?: SpanExporter[];
  /** Time source (epoch ms). Injectable for deterministic tests. */
  now?: () => number;
  /** Id source. Injectable for deterministic tests. */
  idGenerator?: IdGenerator;
}

export interface StartSpanOptions {
  kind?: SpanKind;
  attributes?: Attributes;
  /** Parent span or bare context; when omitted the span starts a new trace. */
  parent?: Span | { traceId: string; spanId: string };
  /** Force a trace id (e.g. reuse the engine's `TraceEvent.traceId`). */
  traceId?: string;
  /** Override the start timestamp. */
  startTime?: number;
}

class SpanImpl implements Span {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | undefined;
  readonly kind: SpanKind;
  name: string;
  private readonly startTime: number;
  private endTime: number | undefined;
  private status: SpanData["status"] = "unset";
  private statusMessage: string | undefined;
  private readonly attributes: Attributes = {};
  private readonly events: SpanEvent[] = [];
  private _ended = false;

  constructor(
    private readonly tracer: Tracer,
    init: {
      traceId: string;
      spanId: string;
      parentSpanId: string | undefined;
      name: string;
      kind: SpanKind;
      startTime: number;
      attributes?: Attributes;
    },
  ) {
    this.traceId = init.traceId;
    this.spanId = init.spanId;
    this.parentSpanId = init.parentSpanId;
    this.name = init.name;
    this.kind = init.kind;
    this.startTime = init.startTime;
    if (init.attributes) Object.assign(this.attributes, init.attributes);
  }

  get ended(): boolean {
    return this._ended;
  }

  setAttribute(key: string, value: AttributeValue): this {
    if (!this._ended) this.attributes[key] = value;
    return this;
  }

  setAttributes(attrs: Attributes): this {
    if (!this._ended) Object.assign(this.attributes, attrs);
    return this;
  }

  addEvent(name: string, attrs: Attributes = {}): this {
    if (!this._ended) {
      this.events.push({ name, ts: this.tracer.now(), attributes: { ...attrs } });
    }
    return this;
  }

  setStatus(status: SpanData["status"], message?: string): this {
    if (!this._ended) {
      this.status = status;
      if (message !== undefined) this.statusMessage = message;
    }
    return this;
  }

  recordException(err: unknown): this {
    const message = err instanceof Error ? err.message : String(err);
    const type = err instanceof Error ? err.name : "Error";
    this.addEvent("exception", { "exception.type": type, "exception.message": message });
    return this.setStatus("error", message);
  }

  child(name: string, kind: SpanKind = "internal", attrs?: Attributes): Span {
    return this.tracer.startSpan(name, {
      kind,
      parent: this,
      ...(attrs ? { attributes: attrs } : {}),
    });
  }

  private build(): SpanData {
    const data: SpanData = {
      traceId: this.traceId,
      spanId: this.spanId,
      name: this.name,
      kind: this.kind,
      startTime: this.startTime,
      status: this.status,
      attributes: { ...this.attributes },
      events: this.events.map((e) => ({ name: e.name, ts: e.ts, attributes: { ...e.attributes } })),
    };
    if (this.parentSpanId !== undefined) data.parentSpanId = this.parentSpanId;
    if (this.endTime !== undefined) {
      data.endTime = this.endTime;
      data.durationMs = this.endTime - this.startTime;
    }
    if (this.statusMessage !== undefined) data.statusMessage = this.statusMessage;
    return data;
  }

  snapshot(): SpanData {
    return this.build();
  }

  end(endTime?: number): SpanData {
    if (this._ended) return this.build();
    this.endTime = endTime ?? this.tracer.now();
    if (this.status === "unset") this.status = "ok";
    this._ended = true;
    const data = this.build();
    this.tracer.dispatch(data);
    return data;
  }
}

export class Tracer {
  private readonly exporters: SpanExporter[];
  readonly now: () => number;
  private readonly ids: IdGenerator;

  constructor(opts: TracerOptions = {}) {
    this.exporters = [...(opts.exporters ?? [])];
    this.now = opts.now ?? Date.now;
    this.ids = opts.idGenerator ?? cryptoIdGenerator;
  }

  /** Register an exporter after construction (e.g. attach a TraceStore). */
  addExporter(exporter: SpanExporter): void {
    this.exporters.push(exporter);
  }

  startSpan(name: string, opts: StartSpanOptions = {}): Span {
    const parentTraceId = opts.parent?.traceId ?? opts.traceId;
    const traceId = parentTraceId ?? this.ids.traceId();
    return new SpanImpl(this, {
      traceId,
      spanId: this.ids.spanId(),
      parentSpanId: opts.parent?.spanId,
      name,
      kind: opts.kind ?? "internal",
      startTime: opts.startTime ?? this.now(),
      ...(opts.attributes ? { attributes: opts.attributes } : {}),
    });
  }

  /** Internal: hand a finished span to every exporter, redacted, never throwing. */
  dispatch(span: SpanData): void {
    const redacted = redactSpanData(span);
    for (const exporter of this.exporters) {
      try {
        exporter.export(redacted);
      } catch {
        /* an exporter failure must never break the traced operation */
      }
    }
  }

  async flush(): Promise<void> {
    for (const exporter of this.exporters) {
      try {
        await exporter.flush?.();
      } catch {
        /* best-effort */
      }
    }
  }

  async shutdown(): Promise<void> {
    for (const exporter of this.exporters) {
      try {
        await exporter.shutdown?.();
      } catch {
        /* best-effort */
      }
    }
  }
}
