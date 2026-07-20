/**
 * Metrics (system-spec §19): counters (monotonic sums) and histograms
 * (distributions) with optional string labels. Kept in-process and allocation-
 * light; a snapshot renders totals + distribution stats for a CLI/`doctor` view
 * or a metrics exporter. The well-known instruments NexusCode records — tokens
 * (in/out/cache), cost USD, latency, TTFT, tool-exec time, errors, retries —
 * are wrapped by {@link RunMetrics}.
 */

import type { Usage } from "@nexuscode/shared";

export type Labels = Record<string, string>;

/** Stable key for a label set so the same labels aggregate together. */
function labelKey(labels: Labels | undefined): string {
  if (!labels) return "";
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

export interface Counter {
  add(value: number, labels?: Labels): void;
}

export interface Histogram {
  record(value: number, labels?: Labels): void;
}

export interface CounterSnapshot {
  name: string;
  unit: string | undefined;
  total: number;
  byLabels: { labels: Labels; value: number }[];
}

export interface HistogramSnapshot {
  name: string;
  unit: string | undefined;
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

export interface MetricsSnapshot {
  counters: Record<string, CounterSnapshot>;
  histograms: Record<string, HistogramSnapshot>;
}

interface InstrumentOpts {
  unit?: string;
  description?: string;
}

class CounterImpl implements Counter {
  private total = 0;
  private readonly buckets = new Map<string, { labels: Labels; value: number }>();

  constructor(
    readonly name: string,
    private readonly unit: string | undefined,
  ) {}

  add(value: number, labels?: Labels): void {
    if (!Number.isFinite(value)) return;
    this.total += value;
    const key = labelKey(labels);
    const existing = this.buckets.get(key);
    if (existing) existing.value += value;
    else this.buckets.set(key, { labels: labels ? { ...labels } : {}, value });
  }

  snapshot(): CounterSnapshot {
    return {
      name: this.name,
      unit: this.unit,
      total: this.total,
      byLabels: [...this.buckets.values()].map((b) => ({ labels: { ...b.labels }, value: b.value })),
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0] as number;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const lov = sorted[lo] as number;
  const hiv = sorted[hi] as number;
  if (lo === hi) return lov;
  return lov + (hiv - lov) * (rank - lo);
}

class HistogramImpl implements Histogram {
  private readonly values: number[] = [];

  constructor(
    readonly name: string,
    private readonly unit: string | undefined,
  ) {}

  record(value: number, _labels?: Labels): void {
    if (!Number.isFinite(value)) return;
    this.values.push(value);
  }

  snapshot(): HistogramSnapshot {
    const sorted = [...this.values].sort((a, b) => a - b);
    const count = sorted.length;
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
      name: this.name,
      unit: this.unit,
      count,
      sum,
      min: count ? (sorted[0] as number) : 0,
      max: count ? (sorted[count - 1] as number) : 0,
      avg: count ? sum / count : 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    };
  }
}

/** A registry of named counters/histograms; instruments are created on demand. */
export class Metrics {
  private readonly counters = new Map<string, CounterImpl>();
  private readonly histograms = new Map<string, HistogramImpl>();

  counter(name: string, opts: InstrumentOpts = {}): Counter {
    let c = this.counters.get(name);
    if (!c) {
      c = new CounterImpl(name, opts.unit);
      this.counters.set(name, c);
    }
    return c;
  }

  histogram(name: string, opts: InstrumentOpts = {}): Histogram {
    let h = this.histograms.get(name);
    if (!h) {
      h = new HistogramImpl(name, opts.unit);
      this.histograms.set(name, h);
    }
    return h;
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, CounterSnapshot> = {};
    for (const [name, c] of this.counters) counters[name] = c.snapshot();
    const histograms: Record<string, HistogramSnapshot> = {};
    for (const [name, h] of this.histograms) histograms[name] = h.snapshot();
    return { counters, histograms };
  }
}

/** Canonical metric names so producers and dashboards agree. */
export const MetricName = {
  tokensIn: "nexus.tokens.input",
  tokensOut: "nexus.tokens.output",
  tokensCache: "nexus.tokens.cache",
  costUsd: "nexus.cost.usd",
  latency: "nexus.latency.ms",
  ttft: "nexus.ttft.ms",
  toolExec: "nexus.tool.exec.ms",
  errors: "nexus.errors",
  retries: "nexus.retries",
} as const;

/**
 * Typed convenience over {@link Metrics} for the well-known NexusCode
 * instruments. Wraps a shared registry so token/cost counters and the
 * latency/TTFT/tool histograms live alongside any ad-hoc metrics.
 */
export class RunMetrics {
  readonly registry: Metrics;

  constructor(registry: Metrics = new Metrics()) {
    this.registry = registry;
  }

  tokens(direction: "in" | "out" | "cache", n: number, labels?: Labels): void {
    const name =
      direction === "in"
        ? MetricName.tokensIn
        : direction === "out"
          ? MetricName.tokensOut
          : MetricName.tokensCache;
    this.registry.counter(name, { unit: "token" }).add(n, labels);
  }

  cost(usd: number, labels?: Labels): void {
    this.registry.counter(MetricName.costUsd, { unit: "usd" }).add(usd, labels);
  }

  latency(ms: number, labels?: Labels): void {
    this.registry.histogram(MetricName.latency, { unit: "ms" }).record(ms, labels);
  }

  /** Time-to-first-token in ms. */
  ttft(ms: number, labels?: Labels): void {
    this.registry.histogram(MetricName.ttft, { unit: "ms" }).record(ms, labels);
  }

  toolExec(ms: number, labels?: Labels): void {
    this.registry.histogram(MetricName.toolExec, { unit: "ms" }).record(ms, labels);
  }

  error(labels?: Labels): void {
    this.registry.counter(MetricName.errors, { unit: "1" }).add(1, labels);
  }

  retry(labels?: Labels): void {
    this.registry.counter(MetricName.retries, { unit: "1" }).add(1, labels);
  }

  /** Fold a normalized {@link Usage} record into the token/cost counters. */
  recordUsage(usage: Usage, labels?: Labels): void {
    this.tokens("in", usage.inputTokens, labels);
    this.tokens("out", usage.outputTokens, labels);
    const cache = (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    if (cache) this.tokens("cache", cache, labels);
    const cost = usage.costUsd ?? usage.reportedCostUsd;
    if (cost != null) this.cost(cost, labels);
  }

  snapshot(): MetricsSnapshot {
    return this.registry.snapshot();
  }
}
