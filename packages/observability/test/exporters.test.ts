/**
 * Exporter + redaction tests: secret span attributes are redacted before an
 * exporter sees them, the NDJSON file exporter round-trips spans, and the OTLP
 * seam buffers without touching the network (a stub fetch is injected).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryExporter,
  NdjsonFileExporter,
  OtlpHttpExporter,
  Tracer,
  readNdjsonSpans,
  sequentialIdGenerator,
  type FetchLike,
} from "../src/index.js";

describe("secret redaction on export", () => {
  it("masks secret-named attributes and secret-shaped values before an exporter sees them", () => {
    const exporter = new InMemoryExporter();
    const tracer = new Tracer({ exporters: [exporter], idGenerator: sequentialIdGenerator() });

    const span = tracer.startSpan("provider.call", { kind: "run" });
    // Secret-named field -> whole value masked.
    span.setAttribute("api_key", "sk-live-ABCDEFGH1234567890XYZ");
    span.setAttribute("authorization", "Bearer abcdef0123456789ABCDEF");
    // Secret-shaped value inside an otherwise-innocent field -> substring masked.
    span.setAttribute("command", "curl -H 'x: sk-proj-ABCDEFGH1234567890abcd' https://api");
    // A benign attribute survives.
    span.setAttribute("model", "mock-1");
    span.addEvent("auth", { token: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" });
    span.end();

    const [s] = exporter.getSpans();
    if (!s) throw new Error("no span");

    expect(s.attributes.api_key).toBe("[REDACTED]");
    expect(s.attributes.authorization).toBe("[REDACTED]");
    expect(String(s.attributes.command)).not.toContain("sk-proj-ABCDEFGH1234567890abcd");
    expect(String(s.attributes.command)).toContain("[REDACTED]");
    expect(s.attributes.model).toBe("mock-1");
    // Event attribute redacted too (secret-named key).
    expect(s.events[0]?.attributes.token).toBe("[REDACTED]");

    // The live handle keeps the raw value (only the exported copy is redacted).
    expect(String(span.snapshot().attributes.api_key)).toContain("sk-live");
  });
});

describe("NdjsonFileExporter round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nexus-obs-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends spans as NDJSON and reads them back identically", () => {
    const file = join(dir, "nested", "trace.ndjson"); // exercises mkdir -p
    const exporter = new NdjsonFileExporter(file);
    const tracer = new Tracer({ exporters: [exporter], idGenerator: sequentialIdGenerator() });

    const run = tracer.startSpan("provider.call", { kind: "run", attributes: { model: "m" } });
    const tool = run.child("fs_read", "tool", { path: "/x" });
    tool.end();
    run.end();

    // Two spans, one JSON object per line.
    const roundTripped = readNdjsonSpans(file);
    expect(roundTripped).toHaveLength(2);
    expect(exporter.read()).toEqual(roundTripped);

    const toolSpan = roundTripped.find((s) => s.kind === "tool");
    const runSpan = roundTripped.find((s) => s.kind === "run");
    expect(runSpan?.attributes.model).toBe("m");
    expect(toolSpan?.attributes.path).toBe("/x");
    expect(toolSpan?.parentSpanId).toBe(runSpan?.spanId);
    // durations survive serialization.
    expect(typeof runSpan?.durationMs).toBe("number");
  });

  it("redacts secrets in the persisted NDJSON", () => {
    const file = join(dir, "secret.ndjson");
    const exporter = new NdjsonFileExporter(file);
    const tracer = new Tracer({ exporters: [exporter], idGenerator: sequentialIdGenerator() });
    const span = tracer.startSpan("x");
    span.setAttribute("password", "hunter2-super-secret");
    span.end();
    const [s] = readNdjsonSpans(file);
    expect(s?.attributes.password).toBe("[REDACTED]");
  });
});

describe("OtlpHttpExporter seam", () => {
  it("buffers spans and POSTs an OTLP-JSON envelope through an injected fetch on flush", async () => {
    const calls: { url: string; body: string }[] = [];
    const stubFetch: FetchLike = async (url, init) => {
      calls.push({ url, body: init.body });
      return { ok: true, status: 200 };
    };
    const exporter = new OtlpHttpExporter({
      endpoint: "http://localhost:4318/v1/traces",
      fetchImpl: stubFetch,
    });
    const tracer = new Tracer({ exporters: [exporter], idGenerator: sequentialIdGenerator() });
    tracer.startSpan("provider.call", { kind: "run" }).end();

    expect(exporter.pending()).toHaveLength(1); // buffered, not yet sent
    await tracer.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:4318/v1/traces");
    const parsed = JSON.parse(calls[0]?.body ?? "{}");
    expect(parsed.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0]?.name).toBe("provider.call");
    expect(exporter.pending()).toHaveLength(0); // drained after flush
  });
});
