/**
 * @nexuscode/session tests. Everything runs offline against a temp SQLite file:
 * a session is seeded through the store's own `EventStore` write side (real
 * writes into the real event_log schema), then listed, named, branched,
 * exported, replayed, and receipted. The Code Receipt tests assert secret
 * redaction, HTML escaping, and that generation is purely local (no network).
 */

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunResult, StreamChunk } from "@nexuscode/core";
import { SessionStore } from "../src/index.js";

let dir: string;
let dbPath: string;
let store: SessionStore;
let seq = 0;

const SESSION = "sess-1";
const TURN = "turn-1";
const RUN = "run-1";

function emit(chunk: StreamChunk, sessionId = SESSION, turnId = TURN, runId = RUN): void {
  store.append({ sessionId, turnId, runId, seq: seq++, chunk });
}

/** Seed a realistic single-turn coding session into the event_log. */
function seedCodingSession(opts: { secret: string; withTest?: boolean }): void {
  emit({ type: "run-start", runId: RUN, adapterId: "mock", model: "mock-large", ts: 1000 });
  emit({ type: "session-init", runId: RUN, providerSessionId: "p1" });
  emit({ type: "text-delta", runId: RUN, text: "Adding a feature flag." });
  emit({ type: "tool-call-start", runId: RUN, id: "tc1", name: "shell" });
  emit({ type: "tool-call-end", runId: RUN, id: "tc1", input: { command: "npm test" } });
  emit({
    type: "file-edit",
    runId: RUN,
    path: "src/app.ts",
    diff: [
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1,2 +1,3 @@",
      " const x = 1;",
      `+const API_TOKEN = "${opts.secret}";`,
      "+export const flag = true;",
    ].join("\n"),
    status: "applied",
  });
  if (opts.withTest) {
    emit({
      type: "tool-result",
      runId: RUN,
      toolCallId: "tc1",
      content: [{ type: "text", text: "Test Files 1 passed (1)\nTests 3 passed (3)" }],
      isError: false,
    });
  }
  emit({ type: "usage", runId: RUN, usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0012 } });
  emit({
    type: "run-end",
    runId: RUN,
    finishReason: "stop",
    message: { role: "assistant", content: [{ type: "text", text: "done" }] },
    ts: 2000,
  });
  const result: RunResult & { sessionId: string; turnId: string } = {
    runId: RUN,
    sessionId: SESSION,
    turnId: TURN,
    adapterId: "mock",
    model: "mock-large",
    status: "ok",
    text: "done",
    toolCalls: [],
    diffs: [],
    usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0012 },
    finishReason: "stop",
  };
  store.summarize(result);
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "nexus-session-"));
  dbPath = join(dir, "history.db");
  store = await SessionStore.open(dbPath);
  seq = 0;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("SessionStore listing & metadata", () => {
  it("lists a seeded session with aggregated metadata", () => {
    seedCodingSession({ secret: "sk-abcdef0123456789abcdef" });
    const sessions = store.listSessions();
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.sessionId).toBe(SESSION);
    expect(s.provider).toBe("mock");
    expect(s.model).toBe("mock-large");
    expect(s.turnCount).toBe(1);
    expect(s.runCount).toBe(1);
    expect(s.inputTokens).toBe(100);
    expect(s.outputTokens).toBe(50);
    expect(s.costUsd).toBeCloseTo(0.0012, 6);
    expect(s.eventCount).toBeGreaterThan(0);
    expect(s.createdAt).toBeGreaterThan(0);
  });

  it("names and renames a session", () => {
    seedCodingSession({ secret: "sk-abcdef0123456789abcdef" });
    store.name(SESSION, "Feature flag work");
    expect(store.getSession(SESSION)?.name).toBe("Feature flag work");
    store.rename(SESSION, "Renamed");
    expect(store.getSession(SESSION)?.name).toBe("Renamed");
  });

  it("deletes a session and all of its rows", () => {
    seedCodingSession({ secret: "sk-abcdef0123456789abcdef" });
    store.snapshot(SESSION, "before delete");
    store.delete(SESSION);
    expect(store.getSession(SESSION)).toBeNull();
    expect(store.listSessions()).toHaveLength(0);
    expect(store.eventsOf(SESSION)).toHaveLength(0);
    expect(store.listSnapshots(SESSION)).toHaveLength(0);
  });
});

describe("snapshots & branching", () => {
  it("captures a snapshot cursor over the append-only log", () => {
    seedCodingSession({ secret: "sk-abcdef0123456789abcdef" });
    const snap = store.snapshot(SESSION, "v1");
    expect(snap.label).toBe("v1");
    expect(snap.eventCount).toBe(store.eventsOf(SESSION).length);
    expect(snap.upToSeq).toBe(seq - 1);
    expect(store.listSnapshots(SESSION)).toHaveLength(1);
  });

  it("branches a new session seeded from the source's events", () => {
    seedCodingSession({ secret: "sk-abcdef0123456789abcdef" });
    const newId = store.branch(SESSION, { name: "Branch A" });
    expect(newId).not.toBe(SESSION);
    const branched = store.getSession(newId);
    expect(branched).not.toBeNull();
    expect(branched!.name).toBe("Branch A");
    // Same event count and run cost carried over, distinct session id.
    expect(store.eventsOf(newId).length).toBe(store.eventsOf(SESSION).length);
    expect(branched!.costUsd).toBeCloseTo(0.0012, 6);
    // Two sessions now listed.
    expect(store.listSessions().map((s) => s.sessionId).sort()).toEqual([SESSION, newId].sort());
  });

  it("branches truncated at a seq boundary", () => {
    seedCodingSession({ secret: "sk-abcdef0123456789abcdef" });
    const cut = 3;
    const newId = store.branch(SESSION, { upToSeq: cut });
    const evs = store.eventsOf(newId);
    expect(evs.length).toBe(cut + 1); // seq 0..cut inclusive
    expect(Math.max(...evs.map((e) => e.seq))).toBeLessThanOrEqual(cut);
  });
});

describe("replay", () => {
  it("re-materializes the session into the UiEvent timeline", () => {
    seedCodingSession({ secret: "sk-abcdef0123456789abcdef", withTest: true });
    const timeline = store.replay(SESSION);
    const types = timeline.map((e) => e.t);
    expect(types).toContain("session");
    expect(types).toContain("text");
    expect(types).toContain("tool_call");
    expect(types).toContain("diff");
    expect(types).toContain("usage");
    expect(types).toContain("done");
    const diff = timeline.find((e) => e.t === "diff");
    expect(diff && diff.t === "diff" && diff.path).toBe("src/app.ts");
    // Replay is deterministic: identical on a second call.
    expect(store.replay(SESSION)).toEqual(timeline);
  });
});

describe("export", () => {
  it("exports markdown with prompt/timeline and redacts secrets", () => {
    const secret = "sk-deadbeef0123456789deadbeef";
    seedCodingSession({ secret });
    const md = store.export(SESSION, "markdown");
    expect(md).toBeTruthy();
    expect(md!).toContain("# Session");
    expect(md!).toContain("src/app.ts");
    expect(md!).not.toContain(secret);
    expect(md!).toContain("[REDACTED]");
  });

  it("exports a self-contained HTML page (inline CSS, no external assets)", () => {
    const secret = "sk-deadbeef0123456789deadbeef";
    seedCodingSession({ secret });
    const html = store.export(SESSION, "html");
    expect(html).toBeTruthy();
    expect(html!).toContain("<!doctype html>");
    expect(html!).toContain("<style>");
    // Self-contained: no external stylesheet/script/font references.
    expect(html!).not.toMatch(/<link[^>]+href=/i);
    expect(html!).not.toMatch(/<script[^>]+src=/i);
    expect(html!).not.toMatch(/https?:\/\//);
    // Secret from the diff never survives into the page.
    expect(html!).not.toContain(secret);
    expect(html!).toContain("[REDACTED]");
  });

  it("exports valid JSON", () => {
    seedCodingSession({ secret: "sk-abcdef0123456789abcdef" });
    const json = store.export(SESSION, "json");
    const parsed = JSON.parse(json!);
    expect(parsed.session.sessionId).toBe(SESSION);
    expect(Array.isArray(parsed.timeline)).toBe(true);
  });

  it("toJson deep-redacts secrets in the timeline and run text (ids/structure remain)", () => {
    const apiSecret = "sk-live0123456789ABCDEFghij0123456789";
    emit({ type: "run-start", runId: RUN, adapterId: "mock", model: "mock-large", ts: 1000 });
    emit({ type: "session-init", runId: RUN, providerSessionId: "p1" });
    emit({ type: "text-delta", runId: RUN, text: `Using key ${apiSecret} and DB_PASSWORD=hunter2` });
    emit({ type: "tool-call-start", runId: RUN, id: "tc1", name: "shell" });
    emit({ type: "tool-call-end", runId: RUN, id: "tc1", input: { command: "npm test" } });
    emit({
      type: "tool-result",
      runId: RUN,
      toolCallId: "tc1",
      content: [{ type: "text", text: `leaked DB_PASSWORD=hunter2 and ${apiSecret}` }],
      isError: false,
    });
    emit({
      type: "file-edit",
      runId: RUN,
      path: "src/app.ts",
      diff: ["--- a/src/app.ts", "+++ b/src/app.ts", `+const KEY = "${apiSecret}";`].join("\n"),
      status: "applied",
    });
    emit({ type: "usage", runId: RUN, usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 } });
    emit({
      type: "run-end",
      runId: RUN,
      finishReason: "stop",
      message: { role: "assistant", content: [{ type: "text", text: `done with ${apiSecret}` }] },
      ts: 2000,
    });
    const result: RunResult & { sessionId: string; turnId: string } = {
      runId: RUN,
      sessionId: SESSION,
      turnId: TURN,
      adapterId: "mock",
      model: "mock-large",
      status: "ok",
      text: `done with ${apiSecret} and DB_PASSWORD=hunter2`,
      toolCalls: [],
      diffs: [],
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 },
      finishReason: "stop",
    };
    store.summarize(result);

    const json = store.export(SESSION, "json");
    expect(json).toBeTruthy();
    // The secrets never survive into the exported JSON, in any field.
    expect(json!).not.toContain(apiSecret);
    expect(json!).not.toContain("hunter2");
    expect(json!).toContain("[REDACTED]");

    // Structural ids/seq/ts are untouched.
    const parsed = JSON.parse(json!);
    expect(parsed.session.sessionId).toBe(SESSION);
    expect(parsed.runs[0].run_id).toBe(RUN);
    expect(parsed.runs[0].text).toContain("[REDACTED]");
    expect(parsed.events.length).toBeGreaterThan(0);
    for (const e of parsed.events) {
      expect(typeof e.seq).toBe("number");
      expect(typeof e.ts).toBe("number");
    }
    const diffEvent = parsed.timeline.find((e: { t: string }) => e.t === "diff");
    expect(diffEvent.path).toBe("src/app.ts");
    expect(diffEvent.patch).not.toContain(apiSecret);
  });
});

describe("Code Receipt (flagship)", () => {
  it("generates a local HTML receipt with prompt + diff, redacting an injected secret", () => {
    const secret = "sk-live-9f8e7d6c5b4a3210abcdef99";
    seedCodingSession({ secret, withTest: true });
    const promptSecret = "AKIAIOSFODNN7EXAMPLE";
    const prompt = `Add a feature flag. My key is ${promptSecret} do not leak it.`;

    const receipt = store.generateReceipt(SESSION, { prompt, outDir: dir });
    expect(receipt).not.toBeNull();
    const { path, html } = receipt!;

    // A real LOCAL file was written.
    expect(existsSync(path)).toBe(true);
    expect(path.startsWith(dir)).toBe(true);
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).toBe(html);

    // Self-contained, branded, OG-style header.
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Code Receipt");
    expect(html).toContain("file"); // "1 file changed"

    // Prompt + diff content are present (escaped).
    expect(html).toContain("Add a feature flag");
    expect(html).toContain("src/app.ts");
    expect(html).toContain("export const flag");

    // Both injected secrets are redacted, nowhere on the page.
    expect(html).not.toContain(secret);
    expect(html).not.toContain(promptSecret);
    expect(html).toContain("[REDACTED]");

    // Real test result => tests-passed badge present.
    expect(html).toContain("Tests passed");
    expect(html).toContain("badge pass");
  });

  it("omits the tests-passed badge when no real test result exists", () => {
    seedCodingSession({ secret: "sk-abcdef0123456789abcdef", withTest: false });
    const receipt = store.generateReceipt(SESSION, { prompt: "do a thing", outDir: dir });
    expect(receipt).not.toBeNull();
    expect(receipt!.html).not.toContain("Tests passed");
    expect(receipt!.html).not.toContain("badge pass");
  });

  it("escapes HTML so a script in the prompt cannot execute (no XSS)", () => {
    seedCodingSession({ secret: "sk-abcdef0123456789abcdef" });
    const receipt = store.generateReceipt(SESSION, {
      prompt: '<script>alert("xss")</script>',
      outDir: dir,
    });
    expect(receipt!.html).not.toContain("<script>alert");
    expect(receipt!.html).toContain("&lt;script&gt;");
  });

  it("is private-by-default: generating a receipt performs no network call", async () => {
    seedCodingSession({ secret: "sk-abcdef0123456789abcdef", withTest: true });
    const fetchSpy = vi.fn();
    const realFetch = globalThis.fetch;
    // @ts-expect-error override for the assertion
    globalThis.fetch = fetchSpy;
    try {
      const receipt = store.generateReceipt(SESSION, { prompt: "p", outDir: dir });
      expect(receipt).not.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
