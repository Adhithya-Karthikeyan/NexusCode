import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ProviderRegistry,
  boundTranscript,
  createEngine,
  dispatch,
  messageTokens,
  userText,
  type Engine,
  type ProviderAdapter,
  type Session,
} from "@nexuscode/core";
import type { ChatRequest, Message } from "@nexuscode/shared";
import { createMockAdapter } from "@nexuscode/provider-mock";

/**
 * A recording adapter: it delegates to the deterministic mock but keeps a copy of
 * every outgoing `ChatRequest`. That is the only honest way to prove conversation
 * memory — what the harness REMEMBERS is exactly what it puts on the wire.
 */
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

async function setup(history?: { enabled?: boolean; maxTokens?: number }): Promise<{
  engine: Engine;
  session: Session;
  requests: ChatRequest[];
}> {
  const { adapter, requests } = spyAdapter();
  const registry = new ProviderRegistry();
  await registry.register(adapter, { skipHealth: true });
  const engine = createEngine({ registry, ...(history ? { history } : {}) });
  const session = await engine.openSession();
  return { engine, session, requests };
}

/** Dispatch one turn end-to-end, exactly as `nexus chat` does. */
async function ask(session: Session, prompt: string | Message[]): Promise<void> {
  const turn =
    typeof prompt === "string" ? session.newTurn({ prompt }) : session.newTurn({ messages: prompt });
  const handle = dispatch(
    {
      kind: "single",
      run: {
        adapterId: "spy",
        model: "mock-fast",
        input: turn.input,
        idempotencyKey: randomUUID(),
      },
    },
    turn.context(),
  );
  for await (const _ of handle.events()) {
    /* drain the stream the way every caller does */
  }
  turn.record(await handle.outcome());
}

function textOf(message: Message): string {
  return message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

function transcriptText(req: ChatRequest): string {
  return req.messages.map(textOf).join("\n");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("engine — session transcript (conversation memory)", () => {
  it("sends turn 1 and turn 2 back with turn 3, so the model can answer from history", async () => {
    const { engine, session, requests } = await setup();

    await ask(session, "My name is Zebra.");
    await ask(session, "What is my name?");
    await ask(session, "And again?");

    expect(requests).toHaveLength(3);

    // Turn 1 is a bare prompt; every later turn carries the whole conversation.
    expect(requests[0]!.messages.map((m) => m.role)).toEqual(["user"]);
    expect(requests[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(requests[2]!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);

    // The load-bearing assertion: turn 3 still contains turn 1's content.
    expect(transcriptText(requests[2]!)).toContain("My name is Zebra.");
    expect(transcriptText(requests[2]!)).toContain("What is my name?");

    // …and the assistant's replies came back too (not just the user's lines).
    expect(transcriptText(requests[2]!)).toContain("[mock-fast] Echo: My name is Zebra.");

    await session.dispose();
    await engine.dispose();
  });

  it("records the reply automatically, even when the caller never calls `record`", async () => {
    const { engine, session, requests } = await setup();

    // No `turn.record(...)`: the engine captures the settled run through the
    // persistence seam, so a caller that only dispatches still remembers.
    for (const prompt of ["first", "second"]) {
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
      await handle.outcome();
    }

    expect(requests[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(transcriptText(requests[1]!)).toContain("[mock-fast] Echo: first");

    await session.dispose();
    await engine.dispose();
  });

  it("does NOT duplicate history when the caller threads it itself (the TUI's path)", async () => {
    const { engine, session, requests } = await setup();

    // Mirror `runTui`: the caller keeps its own transcript and submits
    // `[...prior, ...userText(text)]` on every turn.
    const transcript: Message[] = [];
    for (const text of ["My name is Zebra.", "What is my name?", "And again?"]) {
      const userMsgs = userText(text);
      const turn = session.newTurn({ messages: [...transcript, ...userMsgs] });
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
      const outcome = await handle.outcome();
      transcript.push(...userMsgs);
      const reply = outcome.winner ?? outcome.runs[0];
      if (reply && reply.text.length > 0) {
        transcript.push({ role: "assistant", content: [{ type: "text", text: reply.text }] });
      }
    }

    // Exactly the same shape as the engine-threaded path — history appears ONCE.
    expect(requests[2]!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(occurrences(transcriptText(requests[2]!), "My name is Zebra.")).toBe(2); // user line + its echo
    expect(requests[2]!.messages.filter((m) => m.role === "user" && textOf(m) === "My name is Zebra.")).toHaveLength(1);

    await session.dispose();
    await engine.dispose();
  });

  it("stays bounded: an old turn falls out of the request AND out of the session transcript", async () => {
    // ~100 tokens per line, 300-token budget → only the newest turns survive.
    const { engine, session, requests } = await setup({ maxTokens: 300 });
    const filler = "x".repeat(400);

    await ask(session, `FIRST ${filler}`);
    for (let i = 0; i < 12; i++) await ask(session, `turn ${i} ${filler}`);

    const last = requests[requests.length - 1]!;
    // The oldest turn is gone…
    expect(transcriptText(last)).not.toContain("FIRST");
    // …but the recent conversation is still there.
    expect(transcriptText(last)).toContain("turn 11");

    // Bounded, not growing: 13 turns would be 25 messages unbounded.
    expect(last.messages.length).toBeLessThan(12);
    const tokens = last.messages.reduce((sum, m) => sum + messageTokens(m), 0);
    expect(tokens).toBeLessThanOrEqual(300 + messageTokens(last.messages[last.messages.length - 1]!));

    // The session's own transcript is bounded too (no unbounded memory growth).
    expect(session.transcript.length).toBeLessThan(12);
    expect(session.transcript.reduce((sum, m) => sum + messageTokens(m), 0)).toBeLessThanOrEqual(300);

    await session.dispose();
    await engine.dispose();
  });

  it("keeps the trimmed history opening on a user turn", async () => {
    const { engine, session, requests } = await setup({ maxTokens: 260 });
    const filler = "y".repeat(400);
    for (let i = 0; i < 6; i++) await ask(session, `turn ${i} ${filler}`);

    const last = requests[requests.length - 1]!;
    expect(last.messages[0]!.role).toBe("user");

    await session.dispose();
    await engine.dispose();
  });

  it("can be opted out per engine and per session", async () => {
    const off = await setup({ enabled: false });
    await ask(off.session, "My name is Zebra.");
    await ask(off.session, "What is my name?");
    expect(off.requests[1]!.messages).toHaveLength(1);
    await off.session.dispose();
    await off.engine.dispose();

    // Per-session override: the engine remembers by default, this session does not.
    const on = await setup();
    const stateless = await on.engine.openSession({ history: { enabled: false } });
    await ask(stateless, "My name is Zebra.");
    await ask(stateless, "What is my name?");
    expect(on.requests[1]!.messages).toHaveLength(1);
    await stateless.dispose();
    await on.session.dispose();
    await on.engine.dispose();
  });

  it("seeds a transcript on a resumed session", async () => {
    const { engine, session, requests } = await setup();
    session.setTranscript([
      ...userText("My name is Zebra."),
      { role: "assistant", content: [{ type: "text", text: "Nice to meet you, Zebra." }] },
    ]);

    await ask(session, "What is my name?");

    expect(requests[0]!.messages).toHaveLength(3);
    expect(transcriptText(requests[0]!)).toContain("Zebra");

    await session.dispose();
    await engine.dispose();
  });
});

describe("boundTranscript", () => {
  const msg = (role: Message["role"], text: string): Message => ({
    role,
    content: [{ type: "text", text }],
  });

  it("drops the oldest messages first and never drops the protected tail", () => {
    const messages: Message[] = [
      msg("user", "a".repeat(400)),
      msg("assistant", "b".repeat(400)),
      msg("user", "c".repeat(400)),
      msg("assistant", "d".repeat(400)),
      msg("user", "e".repeat(400)),
    ];
    const bounded = boundTranscript(messages, 220, 1);
    expect(bounded[bounded.length - 1]).toBe(messages[4]);
    expect(bounded.length).toBeLessThan(messages.length);
    expect(bounded).not.toContain(messages[0]);
    expect(bounded[0]!.role).toBe("user");
  });

  it("keeps the tail even when it alone exceeds the budget", () => {
    const messages = [msg("user", "old"), msg("user", "z".repeat(4000))];
    expect(boundTranscript(messages, 10, 1)).toEqual([messages[1]]);
  });

  it("never drops a system message", () => {
    const messages = [
      msg("system", "you are a harness"),
      msg("user", "q".repeat(4000)),
      msg("user", "now"),
    ];
    const bounded = boundTranscript(messages, 20, 1);
    expect(bounded).toContain(messages[0]);
    expect(bounded).not.toContain(messages[1]);
    expect(bounded[bounded.length - 1]).toBe(messages[2]);
  });

  it("is a no-op for an empty transcript", () => {
    expect(boundTranscript([], 100, 0)).toEqual([]);
  });
});
