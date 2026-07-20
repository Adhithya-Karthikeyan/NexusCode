/**
 * TraceStore — an indexed span sink that a CLI `trace` view queries to render
 * the span timeline of a run. It implements {@link SpanExporter}, so attaching
 * it to a tracer (or replaying an NDJSON file into it) is enough to get a
 * queryable tree: roots, parent/child nesting, and per-span offset from the
 * trace start for a Gantt-style ASCII view.
 */

import type { SpanData, SpanExporter } from "./types.js";

/** One row of a flattened timeline: a span, its depth, and its offset. */
export interface TimelineRow {
  span: SpanData;
  /** Nesting depth from the trace root (root = 0). */
  depth: number;
  /** ms from the earliest span start in the trace. */
  offsetMs: number;
  /** span duration in ms (0 while still open). */
  durationMs: number;
}

/** A node in the span tree. */
export interface TraceNode {
  span: SpanData;
  children: TraceNode[];
}

export class TraceStore implements SpanExporter {
  private readonly byTrace = new Map<string, SpanData[]>();

  /** SpanExporter entry point: index a finished span. */
  export(span: SpanData): void {
    this.add(span);
  }

  add(span: SpanData): void {
    const list = this.byTrace.get(span.traceId);
    if (list) list.push(span);
    else this.byTrace.set(span.traceId, [span]);
  }

  /** Bulk-load (e.g. from a replayed NDJSON file). */
  addAll(spans: Iterable<SpanData>): void {
    for (const s of spans) this.add(s);
  }

  traceIds(): string[] {
    return [...this.byTrace.keys()];
  }

  /** All spans in a trace, start-time ordered. */
  getTrace(traceId: string): SpanData[] {
    return [...(this.byTrace.get(traceId) ?? [])].sort((a, b) => a.startTime - b.startTime);
  }

  /** Root spans (no parent, or a parent absent from this trace). */
  roots(traceId: string): SpanData[] {
    const spans = this.getTrace(traceId);
    const ids = new Set(spans.map((s) => s.spanId));
    return spans.filter((s) => s.parentSpanId === undefined || !ids.has(s.parentSpanId));
  }

  /** The span tree for a trace, children start-time ordered. */
  tree(traceId: string): TraceNode[] {
    const spans = this.getTrace(traceId);
    const nodes = new Map<string, TraceNode>();
    for (const s of spans) nodes.set(s.spanId, { span: s, children: [] });
    const roots: TraceNode[] = [];
    for (const s of spans) {
      const node = nodes.get(s.spanId) as TraceNode;
      const parent = s.parentSpanId ? nodes.get(s.parentSpanId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const sortRec = (n: TraceNode) => {
      n.children.sort((a, b) => a.span.startTime - b.span.startTime);
      n.children.forEach(sortRec);
    };
    roots.sort((a, b) => a.span.startTime - b.span.startTime);
    roots.forEach(sortRec);
    return roots;
  }

  /** Flattened, depth-annotated timeline rows in visual (pre-order) sequence. */
  timeline(traceId: string): TimelineRow[] {
    const spans = this.getTrace(traceId);
    if (spans.length === 0) return [];
    const t0 = Math.min(...spans.map((s) => s.startTime));
    const rows: TimelineRow[] = [];
    const walk = (nodes: TraceNode[], depth: number) => {
      for (const n of nodes) {
        rows.push({
          span: n.span,
          depth,
          offsetMs: n.span.startTime - t0,
          durationMs: n.span.durationMs ?? 0,
        });
        walk(n.children, depth + 1);
      }
    };
    walk(this.tree(traceId), 0);
    return rows;
  }
}

/**
 * Render a trace timeline as a compact ASCII Gantt for a CLI `trace show`
 * command. `width` is the character budget for the bar lane.
 */
export function renderTimeline(rows: TimelineRow[], width = 40): string {
  if (rows.length === 0) return "(no spans)";
  const total = Math.max(1, ...rows.map((r) => r.offsetMs + r.durationMs));
  const lines: string[] = [];
  for (const r of rows) {
    const indent = "  ".repeat(r.depth);
    const startCol = Math.floor((r.offsetMs / total) * width);
    const barLen = Math.max(1, Math.round((r.durationMs / total) * width));
    const bar = `${" ".repeat(startCol)}${"█".repeat(Math.min(barLen, width - startCol))}`;
    const status = r.span.status === "error" ? " ✗" : "";
    const label = `${indent}${r.span.name} [${r.span.kind}]`;
    lines.push(`${label.padEnd(34).slice(0, 34)} |${bar.padEnd(width)}| ${r.durationMs}ms${status}`);
  }
  return lines.join("\n");
}
