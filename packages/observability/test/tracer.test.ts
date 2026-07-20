/**
 * Tracer/span tests: nested spans record parent/child + attributes, timed
 * events attach, and status/exception handling behaves. Uses an
 * InMemoryExporter and a deterministic id generator so assertions are exact.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryExporter,
  Tracer,
  sequentialIdGenerator,
} from "../src/index.js";

function fixedClock() {
  let t = 1000;
  return () => (t += 5);
}

describe("Tracer / Span nesting", () => {
  it("records parent/child relationships and attributes across three levels", () => {
    const exporter = new InMemoryExporter();
    const tracer = new Tracer({
      exporters: [exporter],
      idGenerator: sequentialIdGenerator(),
      now: fixedClock(),
    });

    const run = tracer.startSpan("provider.call", { kind: "run", attributes: { model: "mock-1" } });
    run.setAttribute("temperature", 0.2);

    const tool = run.child("fs_read", "tool", { path: "/etc/hosts" });
    tool.addEvent("permission.granted", { by: "auto" });

    const subprocess = tool.child("git status", "subprocess");
    subprocess.setAttributes({ "process.exit_code": 0, argv: ["git", "status"] });

    // End innermost-first, as a real bracketed run would.
    subprocess.end();
    tool.end();
    run.end();

    const spans = exporter.getSpans();
    expect(spans).toHaveLength(3);

    // Export order is end order: subprocess, tool, run.
    const [sub, toolSpan, runSpan] = spans;
    if (!sub || !toolSpan || !runSpan) throw new Error("missing spans");

    // Same trace id everywhere.
    expect(sub.traceId).toBe(runSpan.traceId);
    expect(toolSpan.traceId).toBe(runSpan.traceId);

    // Parent chain: run <- tool <- subprocess.
    expect(runSpan.parentSpanId).toBeUndefined();
    expect(toolSpan.parentSpanId).toBe(runSpan.spanId);
    expect(sub.parentSpanId).toBe(toolSpan.spanId);

    // Kinds preserved.
    expect(runSpan.kind).toBe("run");
    expect(toolSpan.kind).toBe("tool");
    expect(sub.kind).toBe("subprocess");

    // Attributes preserved.
    expect(runSpan.attributes.model).toBe("mock-1");
    expect(runSpan.attributes.temperature).toBe(0.2);
    expect(toolSpan.attributes.path).toBe("/etc/hosts");
    expect(sub.attributes["process.exit_code"]).toBe(0);
    expect(sub.attributes.argv).toEqual(["git", "status"]);

    // Event recorded on the tool span.
    expect(toolSpan.events).toHaveLength(1);
    expect(toolSpan.events[0]?.name).toBe("permission.granted");
    expect(toolSpan.events[0]?.attributes.by).toBe("auto");

    // Durations computed and positive.
    expect(runSpan.durationMs).toBeGreaterThan(0);
    expect(runSpan.status).toBe("ok");
  });

  it("marks error status and records an exception event", () => {
    const exporter = new InMemoryExporter();
    const tracer = new Tracer({ exporters: [exporter], idGenerator: sequentialIdGenerator() });
    const span = tracer.startSpan("tool.run", { kind: "tool" });
    span.recordException(new TypeError("boom"));
    span.end();

    const [s] = exporter.getSpans();
    if (!s) throw new Error("no span");
    expect(s.status).toBe("error");
    expect(s.statusMessage).toBe("boom");
    const ex = s.events.find((e) => e.name === "exception");
    expect(ex?.attributes["exception.type"]).toBe("TypeError");
    expect(ex?.attributes["exception.message"]).toBe("boom");
  });

  it("is idempotent on double-end and rejects mutation after end", () => {
    const exporter = new InMemoryExporter();
    const tracer = new Tracer({ exporters: [exporter], idGenerator: sequentialIdGenerator() });
    const span = tracer.startSpan("x");
    span.end();
    span.setAttribute("late", true);
    span.end();
    expect(exporter.getSpans()).toHaveLength(1);
    expect(exporter.getSpans()[0]?.attributes.late).toBeUndefined();
  });
});
