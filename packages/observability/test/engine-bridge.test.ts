/**
 * Engine-bridge tests: a simulated run driven purely through `CallContext.emit`
 * style `TraceEvent`s produces a nested run > tool > subprocess span tree, folds
 * usage into metrics, records TTFT, and bumps the error counter on a failed
 * tool. This is the seam the core kernel uses (`ctx.emit`).
 */

import { describe, expect, it } from "vitest";
import {
  EngineTracer,
  InMemoryExporter,
  Tracer,
  TraceStore,
  firstTokenEvent,
  sequentialIdGenerator,
  spanEndEvent,
  spanStartEvent,
  MetricName,
} from "../src/index.js";

describe("EngineTracer via CallContext.emit", () => {
  it("reconstructs a nested run/tool/subprocess tree from trace events", () => {
    const exporter = new InMemoryExporter();
    const store = new TraceStore();
    const tracer = new Tracer({
      exporters: [exporter, store],
      idGenerator: sequentialIdGenerator(),
    });
    const engineTracer = new EngineTracer({ tracer });
    const emit = engineTracer.emit; // must be usable detached (bound in ctor)

    const traceId = "trace-fixed";
    const runId = "run_abc";

    // Simulate the engine bracketing a provider call, a tool, and a subprocess.
    emit(spanStartEvent(traceId, "run_abc", { name: "provider.call", kind: "run", runId, ts: 100 }));
    emit(firstTokenEvent(traceId, "run_abc", { runId, ts: 140 })); // TTFT = 40ms
    emit(spanStartEvent(traceId, "tool:call-1", { name: "fs_read", kind: "tool", ts: 150 }));
    emit(
      spanStartEvent(traceId, "subprocess:git-1", {
        name: "git status",
        kind: "subprocess",
        attributes: { argv: ["git", "status"] },
        ts: 160,
      }),
    );
    emit(spanEndEvent(traceId, "subprocess:git-1", { status: "ok", ts: 210 }));
    emit(spanEndEvent(traceId, "tool:call-1", { status: "ok", ts: 230 }));
    emit(
      spanEndEvent(traceId, "run_abc", {
        status: "ok",
        usage: { inputTokens: 120, outputTokens: 45, costUsd: 0.003 },
        ts: 300,
      }),
    );

    const spans = exporter.getSpans();
    expect(spans).toHaveLength(3);

    const run = spans.find((s) => s.kind === "run");
    const tool = spans.find((s) => s.kind === "tool");
    const sub = spans.find((s) => s.kind === "subprocess");
    if (!run || !tool || !sub) throw new Error("missing kind span");

    // All in one trace, correct nesting.
    expect(run.traceId).toBe(traceId);
    expect(run.parentSpanId).toBeUndefined();
    expect(tool.parentSpanId).toBe(run.spanId);
    expect(sub.parentSpanId).toBe(tool.spanId);

    // run carries usage attributes + TTFT.
    expect(run.attributes["nexus.usage.input"]).toBe(120);
    expect(run.attributes["nexus.usage.output"]).toBe(45);
    expect(run.attributes["nexus.cost_usd"]).toBe(0.003);
    expect(run.attributes["nexus.ttft_ms"]).toBe(40);
    expect(run.attributes["nexus.run_id"]).toBe(runId);
    expect(run.durationMs).toBe(200);

    // subprocess argv passthrough.
    expect(sub.attributes.argv).toEqual(["git", "status"]);

    // Metrics folded in.
    const snap = engineTracer.metrics.snapshot();
    expect(snap.counters[MetricName.tokensIn]?.total).toBe(120);
    expect(snap.counters[MetricName.tokensOut]?.total).toBe(45);
    expect(snap.counters[MetricName.costUsd]?.total).toBeCloseTo(0.003, 6);
    expect(snap.histograms[MetricName.ttft]?.sum).toBe(40);
    expect(snap.histograms[MetricName.latency]?.sum).toBe(200); // run duration
    expect(snap.histograms[MetricName.toolExec]?.count).toBe(2); // tool + subprocess

    // TraceStore can render the timeline.
    const timeline = store.timeline(traceId);
    expect(timeline.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(timeline[0]?.span.kind).toBe("run");
    expect(timeline[0]?.offsetMs).toBe(0);
  });

  it("bumps the error counter and sets error status on a failed tool", () => {
    const exporter = new InMemoryExporter();
    const tracer = new Tracer({ exporters: [exporter], idGenerator: sequentialIdGenerator() });
    const engineTracer = new EngineTracer({ tracer });
    const { emit } = engineTracer;
    const traceId = "t-err";

    emit(spanStartEvent(traceId, "run_1", { kind: "run", ts: 0 }));
    emit(spanStartEvent(traceId, "tool:t1", { kind: "tool", ts: 10 }));
    emit(spanEndEvent(traceId, "tool:t1", { status: "error", message: "ENOENT", ts: 20 }));
    emit(spanEndEvent(traceId, "run_1", { status: "ok", ts: 30 }));

    const tool = exporter.getSpans().find((s) => s.kind === "tool");
    expect(tool?.status).toBe("error");
    expect(tool?.statusMessage).toBe("ENOENT");
    expect(engineTracer.metrics.snapshot().counters[MetricName.errors]?.total).toBe(1);
  });

  it("records an orphan point event as a queryable marker span", () => {
    const exporter = new InMemoryExporter();
    const tracer = new Tracer({ exporters: [exporter], idGenerator: sequentialIdGenerator() });
    const engineTracer = new EngineTracer({ tracer });
    // No open span: a store-error style point event still lands.
    engineTracer.emit({ type: "store-error", traceId: "t-x", ts: 5, data: "disk full" });
    const spans = exporter.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe("store-error");
    expect(spans[0]?.status).toBe("error");
    expect(engineTracer.metrics.snapshot().counters[MetricName.errors]?.total).toBe(1);
  });
});
