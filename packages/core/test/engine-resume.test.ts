/**
 * Session resume at the engine level: a conversation persisted through the
 * `EventStore` transcript seam must come back on `openSession({ resume })` and be
 * threaded into the next turn's request.
 *
 * The store here is a fake in-memory one, which is the point — the engine must
 * stay storage-agnostic, and a store that does NOT implement the optional seam
 * must keep working exactly as before.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ProviderRegistry,
  createEngine,
  dispatch,
  type Engine,
  type EventStore,
  type ProviderAdapter,
  type Session,
} from "@nexuscode/core";
import type { ChatRequest, Message } from "@nexuscode/shared";
import { createMockAdapter } from "@nexuscode/provider-mock";

/** An in-memory `EventStore` implementing the optional transcript seam. */
function fakeStore(): EventStore & { rows: Map<number, Message[]>; sessions: string[] } {
  const rows = new Map<number, Message[]>();
  const sessions: string[] = [];
  return {
    rows,
    sessions,
    append() {
      /* not under test */
    },
    summarize() {
      /* not under test */
    },
    appendTranscript(entry) {
      if (!sessions.includes(entry.sessionId)) sessions.push(entry.sessionId);
      rows.set(entry.seq, entry.messages); // same seq REPLACES, as documented
    },
    loadTranscript() {
      return [...rows.keys()].sort((a, b) => a - b).flatMap((k) => rows.get(k) ?? []);
    },
  };
}

function spyAdapter(): { adapter: ProviderAdapter; requests: ChatRequest[] } {
  const base = createMockAdapter({ id: "spy" });
  const requests: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    ...base,
    chat(req, ctx) {
      requests.push(structuredClone(req));
      return base.chat(req, ctx);
    },
    stream(req, ctx) {
      requests.push(structuredClone(req));
      return base.stream(req, ctx);
    },
  };
  return { adapter, requests };
}

async function makeEngine(
  store?: EventStore,
  history?: { maxTokens?: number },
): Promise<{ engine: Engine; requests: ChatRequest[] }> {
  const { adapter, requests } = spyAdapter();
  const registry = new ProviderRegistry();
  await registry.register(adapter, { skipHealth: true });
  const engine = createEngine({
    registry,
    ...(store ? { store } : {}),
    ...(history ? { history } : {}),
  });
  return { engine, requests };
}

async function ask(session: Session, prompt: string): Promise<void> {
  const turn = session.newTurn({ prompt });
  const handle = dispatch(
    {
      kind: "single",
      run: { adapterId: "spy", model: "mock-fast", input: turn.input, idempotencyKey: randomUUID() },
    },
    turn.context(),
  );
  for await (const _ of handle.events()) {
    /* drain */
  }
  turn.record(await handle.outcome());
}

function textOf(m: Message): string {
  return m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

describe("engine — session resume", () => {
  it("rehydrates a stored conversation and threads it into the next turn", async () => {
    const store = fakeStore();

    // Process 1: two turns, then the engine is disposed entirely.
    const first = await makeEngine(store);
    const s1 = await first.engine.openSession();
    const sessionId = s1.id;
    await ask(s1, "My name is Zebra.");
    await ask(s1, "I work on NexusCode.");
    await s1.dispose();
    await first.engine.dispose();

    // Process 2: a brand-new engine over the same store.
    const second = await makeEngine(store);
    const s2 = await second.engine.openSession({ resume: sessionId });

    expect(s2.transcript.length).toBe(4); // 2 user + 2 assistant
    expect(s2.transcript.map(textOf).join("\n")).toContain("My name is Zebra.");

    await ask(s2, "What is my name?");

    const req = second.requests[0]!;
    expect(req.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(req.messages.map(textOf).join("\n")).toContain("My name is Zebra.");
    // The resumed turns are not re-persisted under new sequence numbers.
    expect(store.rows.size).toBe(6);

    await s2.dispose();
    await second.engine.dispose();
  });

  it("starts fresh, without error, when the session has nothing stored", async () => {
    const store = fakeStore();
    const { engine, requests } = await makeEngine(store);
    const session = await engine.openSession({ resume: "s_never_seen" });

    expect(session.transcript).toHaveLength(0);
    await ask(session, "hello");
    expect(requests[0]!.messages).toHaveLength(1);

    await session.dispose();
    await engine.dispose();
  });

  it("works with a store that does NOT implement the optional seam", async () => {
    const bare: EventStore = { append() {}, summarize() {} };
    const { engine, requests } = await makeEngine(bare);
    const session = await engine.openSession({ resume: "s_anything" });

    expect(session.transcript).toHaveLength(0);
    await ask(session, "hello");
    expect(requests[0]!.messages).toHaveLength(1);

    await session.dispose();
    await engine.dispose();
  });

  it("applies the SAME bound on resume — a huge stored history cannot blow the window", async () => {
    const store = fakeStore();
    const filler = "x".repeat(400);

    const first = await makeEngine(store, { maxTokens: 300 });
    const s1 = await first.engine.openSession();
    const sessionId = s1.id;
    await ask(s1, `FIRST ${filler}`);
    for (let i = 0; i < 8; i++) await ask(s1, `turn ${i} ${filler}`);
    await s1.dispose();
    await first.engine.dispose();

    // The store kept everything; the resumed SESSION must not.
    expect(store.loadTranscript!("x")).not.toHaveLength(0);

    const second = await makeEngine(store, { maxTokens: 300 });
    const s2 = await second.engine.openSession({ resume: sessionId });

    expect(s2.transcript.length).toBeLessThan(10);
    expect(s2.transcript.map(textOf).join("\n")).not.toContain("FIRST");
    expect(s2.transcript.map(textOf).join("\n")).toContain("turn 7");

    await s2.dispose();
    await second.engine.dispose();
  });

  it("resumes onto a valid boundary when the last turn was never answered", async () => {
    // A crashed/errored turn leaves a dangling user message. Replaying it would
    // put two user messages back to back, which strict-alternation providers
    // (Anthropic) reject — and it was never actually answered.
    const store = fakeStore();
    store.appendTranscript!({
      sessionId: "s_crashed",
      turnId: "t1",
      seq: 0,
      messages: [{ role: "user", content: [{ type: "text", text: "answered question" }] }],
    });
    store.appendTranscript!({
      sessionId: "s_crashed",
      turnId: "t1",
      seq: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "the answer" }] }],
    });
    store.appendTranscript!({
      sessionId: "s_crashed",
      turnId: "t2",
      seq: 2,
      messages: [{ role: "user", content: [{ type: "text", text: "never answered" }] }],
    });

    const { engine, requests } = await makeEngine(store);
    const session = await engine.openSession({ resume: "s_crashed" });

    expect(session.transcript.map((m) => m.role)).toEqual(["user", "assistant"]);

    await ask(session, "next question");
    expect(requests[0]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

    await session.dispose();
    await engine.dispose();
  });

  it("does not persist anything when conversation memory is disabled", async () => {
    const store = fakeStore();
    const { engine } = await makeEngine(store, undefined);
    const session = await engine.openSession({ history: { enabled: false } });
    await ask(session, "hello");
    expect(store.rows.size).toBe(0);
    await session.dispose();
    await engine.dispose();
  });
});
