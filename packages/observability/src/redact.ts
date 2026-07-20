/**
 * Secret redaction for span attributes/events. We reuse the exact same pass
 * used for tool-argument and history redaction (`@nexuscode/tools`) so a trace
 * sink can never store a credential an approval prompt wouldn't have shown —
 * key-name heuristics (`api_key`, `authorization`, …) mask the whole value, and
 * value-shape heuristics (`sk-…`, bearer tokens, PEM blocks) scrub substrings.
 */

import { redactArgs, redactSecrets } from "@nexuscode/tools";
import type { Attributes, SpanData, SpanEvent } from "./types.js";

/** Redact an attribute bag (deep-cloned; originals untouched). */
export function redactAttributes(attrs: Attributes): Attributes {
  return redactArgs(attrs) as Attributes;
}

/** Redact a status message string (value-shape scrub only). */
export function redactMessage(msg: string): string {
  return redactSecrets(msg);
}

/** Redact every secret-bearing surface of a span before it reaches an exporter. */
export function redactSpanData(span: SpanData): SpanData {
  const events: SpanEvent[] = span.events.map((e) => ({
    name: e.name,
    ts: e.ts,
    attributes: redactAttributes(e.attributes),
  }));
  const out: SpanData = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    kind: span.kind,
    startTime: span.startTime,
    status: span.status,
    attributes: redactAttributes(span.attributes),
    events,
  };
  if (span.parentSpanId !== undefined) out.parentSpanId = span.parentSpanId;
  if (span.endTime !== undefined) out.endTime = span.endTime;
  if (span.durationMs !== undefined) out.durationMs = span.durationMs;
  if (span.statusMessage !== undefined) out.statusMessage = redactMessage(span.statusMessage);
  return out;
}
