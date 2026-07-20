/**
 * Metrics tests: counters aggregate token/cost totals (and per-label buckets),
 * histograms aggregate latency distribution stats, and a `Usage` record folds
 * into the right instruments.
 */

import { describe, expect, it } from "vitest";
import type { Usage } from "@nexuscode/shared";
import { Metrics, MetricName, RunMetrics } from "../src/index.js";

describe("Metrics aggregation", () => {
  it("aggregates token, cost, and latency across multiple records", () => {
    const m = new RunMetrics();

    m.recordUsage({ inputTokens: 100, outputTokens: 40, costUsd: 0.002 }, { run: "r1" });
    m.recordUsage(
      { inputTokens: 250, outputTokens: 60, cacheReadTokens: 30, costUsd: 0.005 },
      { run: "r2" },
    );
    m.latency(120, { kind: "run" });
    m.latency(80, { kind: "run" });
    m.latency(200, { kind: "run" });

    const snap = m.snapshot();

    expect(snap.counters[MetricName.tokensIn]?.total).toBe(350);
    expect(snap.counters[MetricName.tokensOut]?.total).toBe(100);
    expect(snap.counters[MetricName.tokensCache]?.total).toBe(30);
    expect(snap.counters[MetricName.costUsd]?.total).toBeCloseTo(0.007, 6);

    const lat = snap.histograms[MetricName.latency];
    expect(lat?.count).toBe(3);
    expect(lat?.sum).toBe(400);
    expect(lat?.min).toBe(80);
    expect(lat?.max).toBe(200);
    expect(lat?.avg).toBeCloseTo(133.33, 1);
    expect(lat?.p50).toBe(120);
  });

  it("keeps per-label buckets on a counter", () => {
    const m = new Metrics();
    const c = m.counter("nexus.errors");
    c.add(1, { kind: "tool" });
    c.add(1, { kind: "tool" });
    c.add(1, { kind: "run" });

    const snap = m.snapshot().counters["nexus.errors"];
    expect(snap?.total).toBe(3);
    const byTool = snap?.byLabels.find((b) => b.labels.kind === "tool");
    const byRun = snap?.byLabels.find((b) => b.labels.kind === "run");
    expect(byTool?.value).toBe(2);
    expect(byRun?.value).toBe(1);
  });

  it("records TTFT, tool-exec, errors, and retries via the typed wrapper", () => {
    const m = new RunMetrics();
    m.ttft(45, { kind: "run" });
    m.toolExec(12, { kind: "tool" });
    m.toolExec(30, { kind: "tool" });
    m.error({ kind: "tool" });
    m.retry();
    m.retry();

    const snap = m.snapshot();
    expect(snap.histograms[MetricName.ttft]?.count).toBe(1);
    expect(snap.histograms[MetricName.ttft]?.sum).toBe(45);
    expect(snap.histograms[MetricName.toolExec]?.count).toBe(2);
    expect(snap.histograms[MetricName.toolExec]?.sum).toBe(42);
    expect(snap.counters[MetricName.errors]?.total).toBe(1);
    expect(snap.counters[MetricName.retries]?.total).toBe(2);
  });

  it("prefers reportedCostUsd when present", () => {
    const m = new RunMetrics();
    const usage: Usage = { inputTokens: 10, outputTokens: 5, reportedCostUsd: 0.99 };
    m.recordUsage(usage);
    expect(m.snapshot().counters[MetricName.costUsd]?.total).toBeCloseTo(0.99, 6);
  });
});
