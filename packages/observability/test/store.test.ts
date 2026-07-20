/**
 * TraceStore/timeline tests: the store indexes spans by trace, exposes the
 * parent/child tree and a depth-annotated timeline with offsets, and can be
 * bulk-loaded from replayed NDJSON. `renderTimeline` produces an ASCII Gantt.
 */

import { describe, expect, it } from "vitest";
import {
  InMemoryExporter,
  TraceStore,
  Tracer,
  renderTimeline,
  sequentialIdGenerator,
} from "../src/index.js";

describe("TraceStore timeline", () => {
  it("builds a depth-annotated timeline with offsets from the trace start", () => {
    const mem = new InMemoryExporter();
    const store = new TraceStore();
    let t = 0;
    const tracer = new Tracer({
      exporters: [mem, store],
      idGenerator: sequentialIdGenerator(),
      now: () => (t += 10),
    });

    const run = tracer.startSpan("provider.call", { kind: "run" }); // start=10
    const toolA = run.child("fs_read", "tool"); // start=20
    toolA.end(); // end=30
    const toolB = run.child("shell_exec", "tool"); // start=40
    const sub = toolB.child("git status", "subprocess"); // start=50
    sub.end(); // 60
    toolB.end(); // 70
    run.end(); // 80

    const [traceId] = store.traceIds();
    if (!traceId) throw new Error("no trace");

    const roots = store.roots(traceId);
    expect(roots).toHaveLength(1);
    expect(roots[0]?.kind).toBe("run");

    const tree = store.tree(traceId);
    expect(tree[0]?.children).toHaveLength(2); // two tools under the run
    const shell = tree[0]?.children.find((c) => c.span.name === "shell_exec");
    expect(shell?.children[0]?.span.kind).toBe("subprocess");

    const timeline = store.timeline(traceId);
    // Pre-order: run, fs_read, shell_exec, git status.
    expect(timeline.map((r) => r.span.name)).toEqual([
      "provider.call",
      "fs_read",
      "shell_exec",
      "git status",
    ]);
    expect(timeline.map((r) => r.depth)).toEqual([0, 1, 1, 2]);
    // Offsets are relative to earliest start (the run at t=10).
    expect(timeline[0]?.offsetMs).toBe(0);
    expect(timeline[1]?.offsetMs).toBe(10); // fs_read at 20
    expect(timeline[3]?.offsetMs).toBe(40); // git status at 50

    const rendered = renderTimeline(timeline);
    expect(rendered).toContain("provider.call");
    expect(rendered).toContain("git status");
    expect(rendered.split("\n")).toHaveLength(4);
  });

  it("bulk-loads replayed spans and groups by trace id", () => {
    const store = new TraceStore();
    store.addAll([
      { traceId: "A", spanId: "a1", name: "root", kind: "run", startTime: 0, status: "ok", attributes: {}, events: [] },
      { traceId: "A", spanId: "a2", parentSpanId: "a1", name: "child", kind: "tool", startTime: 1, status: "ok", attributes: {}, events: [] },
      { traceId: "B", spanId: "b1", name: "other", kind: "run", startTime: 0, status: "ok", attributes: {}, events: [] },
    ]);
    expect(new Set(store.traceIds())).toEqual(new Set(["A", "B"]));
    expect(store.getTrace("A")).toHaveLength(2);
    expect(store.roots("A").map((s) => s.spanId)).toEqual(["a1"]);
    expect(store.timeline("A").map((r) => r.depth)).toEqual([0, 1]);
  });

  it("returns an empty timeline for an unknown trace", () => {
    const store = new TraceStore();
    expect(store.timeline("nope")).toEqual([]);
    expect(renderTimeline([])).toBe("(no spans)");
  });
});
