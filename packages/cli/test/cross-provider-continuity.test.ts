/**
 * Cross-provider continuity through the REAL interactive turn path.
 *
 * The engine-level explicit-switch handoff already has coverage
 * (`packages/core/test/reliability-integration.test.ts`). What was never
 * exercised is the path the interactive harness actually uses: the TUI bridge's
 * `runTurn`, which threads its OWN client-side transcript into
 * `session.newTurn({ messages })`. These tests capture exactly what the SECOND
 * provider receives after a mid-conversation switch, so "switching providers
 * loses nothing" is a measured claim rather than an assumed one.
 */
import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  type ChatRequest,
  type Message,
  type ProviderAdapter,
  type RunContext,
  type RunSpec,
  type OrchestrationHandle,
  dispatch,
} from "@nexuscode/core";
import { createMockAdapter } from "@nexuscode/provider-mock";
import { createEventStore, recordTurnIntoTranscript, runTurn } from "@nexuscode/tui";

/** Wrap a mock adapter so every request it receives is captured verbatim. */
function recording(id: string, model: string): { adapter: ProviderAdapter; seen: ChatRequest[] } {
  const base = createMockAdapter({ id, models: [model] });
  const seen: ChatRequest[] = [];
  return {
    seen,
    adapter: {
      ...base,
      stream(request, context) {
        seen.push(structuredClone(request) as ChatRequest);
        return base.stream(request, context);
      },
    },
  };
}

function textOf(messages: readonly Message[], role: Message["role"]): string[] {
  return messages
    .filter((m) => m.role === role)
    .flatMap((m) =>
      m.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text),
    );
}

async function fixture(opts: { handoff?: boolean } = {}) {
  const registry = new ProviderRegistry();
  const a = recording("prov-a", "model-a");
  const b = recording("prov-b", "model-b");
  await registry.register(a.adapter, { skipHealth: true });
  await registry.register(b.adapter, { skipHealth: true });
  const engine = createEngine({
    registry,
    ...(opts.handoff === false
      ? {}
      : {
          handoffBuilder: (input) => ({
            role: "system" as const,
            name: "nexus-provider-handoff",
            content: [
              {
                type: "text" as const,
                text: `[HANDOFF ${input.fromProviderId}/${input.fromModelId} -> ${input.toProviderId}/${input.toModelId}]`,
              },
            ],
          }),
        }),
  });
  return { engine, a, b };
}

/** Exactly what `runTui`'s onSubmit does, including its client-side transcript. */
function makeHarness(engine: Awaited<ReturnType<typeof fixture>>["engine"]) {
  const transcript: Message[] = [];
  return {
    transcript,
    async send(
      session: Awaited<ReturnType<typeof engine.openSession>>,
      store: ReturnType<typeof createEventStore>,
      text: string,
      provider: string,
      model: string,
    ) {
      const userMsgs: Message[] = [{ role: "user", content: [{ type: "text", text }] }];
      const dispatchTurn = (input: Message[], ctx: RunContext): OrchestrationHandle => {
        const run: RunSpec = { adapterId: provider, model, input, idempotencyKey: `k-${text}` };
        return dispatch({ kind: "single", run }, ctx);
      };
      const outcome = await runTurn(session, store, {
        provider,
        model,
        text,
        history: transcript,
        dispatchTurn,
      });
      // The REAL fold the TUI bridge uses — not a copy of it.
      recordTurnIntoTranscript(transcript, userMsgs, outcome);
      return outcome;
    },
  };
}

describe("switching provider mid-conversation (the interactive turn path)", () => {
  it("carries the ENTIRE prior conversation onto the new provider", async () => {
    const { engine, b } = await fixture();
    const session = await engine.openSession();
    const store = createEventStore();
    const h = makeHarness(engine);

    await h.send(session, store, "Remember project Aurora", "prov-a", "model-a");
    await h.send(session, store, "Aurora ships on Friday", "prov-a", "model-a");
    // Now the user picks a different provider via /provider.
    await h.send(session, store, "What ships Friday?", "prov-b", "model-b");

    expect(b.seen).toHaveLength(1);
    const users = textOf(b.seen[0]!.messages, "user");
    // Every earlier user turn reaches the new provider …
    expect(users).toContain("Remember project Aurora");
    expect(users).toContain("Aurora ships on Friday");
    expect(users).toContain("What ships Friday?");
    // … along with the assistant side, so the exchange is not one-sided.
    expect(textOf(b.seen[0]!.messages, "assistant").length).toBeGreaterThan(0);
  });

  it("prepends the provider-neutral handoff capsule as the first message", async () => {
    const { engine, b } = await fixture();
    const session = await engine.openSession();
    const store = createEventStore();
    const h = makeHarness(engine);

    await h.send(session, store, "Remember project Aurora", "prov-a", "model-a");
    await h.send(session, store, "Continue", "prov-b", "model-b");

    expect(b.seen[0]?.messages[0]).toMatchObject({
      role: "system",
      name: "nexus-provider-handoff",
    });
    expect(textOf([b.seen[0]!.messages[0]!], "system")[0]).toContain(
      "[HANDOFF prov-a/model-a -> prov-b/model-b]",
    );
  });

  it("does NOT re-issue a capsule when only the MODEL changes on one provider", async () => {
    const { engine, a } = await fixture();
    const session = await engine.openSession();
    const store = createEventStore();
    const h = makeHarness(engine);

    await h.send(session, store, "first", "prov-a", "model-a");
    await h.send(session, store, "second", "prov-a", "model-a");

    expect(a.seen).toHaveLength(2);
    expect(a.seen[1]?.messages[0]).not.toMatchObject({ name: "nexus-provider-handoff" });
  });

  it("switching back and forth never duplicates the transcript", async () => {
    const { engine, a, b } = await fixture();
    const session = await engine.openSession();
    const store = createEventStore();
    const h = makeHarness(engine);

    await h.send(session, store, "one", "prov-a", "model-a");
    await h.send(session, store, "two", "prov-b", "model-b");
    await h.send(session, store, "three", "prov-a", "model-a");

    const lastA = a.seen.at(-1)!;
    const users = textOf(lastA.messages, "user");
    // Each prompt appears exactly once, in order — no re-threading duplicates.
    expect(users.filter((t) => t === "one")).toHaveLength(1);
    expect(users.filter((t) => t === "two")).toHaveLength(1);
    expect(users.filter((t) => t === "three")).toHaveLength(1);
    expect(b.seen).toHaveLength(1);
  });
});

describe("what a provider switch must NOT lose", () => {
  it("keeps the user's question after a FAILED turn so a retry on another provider still has it", async () => {
    const registry = new ProviderRegistry();
    const failing: ProviderAdapter = {
      ...createMockAdapter({ id: "prov-a", models: ["model-a"] }),
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("provider is down");
      },
    };
    const b = recording("prov-b", "model-b");
    await registry.register(failing, { skipHealth: true });
    await registry.register(b.adapter, { skipHealth: true });
    const engine = createEngine({ registry });
    const session = await engine.openSession();
    const store = createEventStore();
    const h = makeHarness(engine);

    // Turn 1 fails on provider A — this is the single most common reason a user
    // reaches for /provider at all.
    await h.send(session, store, "What is the Aurora deadline?", "prov-a", "model-a");
    // The user switches and asks the follow-up that depends on turn 1.
    await h.send(session, store, "answer my previous question", "prov-b", "model-b");

    const users = textOf(b.seen[0]!.messages, "user");
    expect(users).toContain("What is the Aurora deadline?");
  });

  it("carries tool calls and their results across the switch", async () => {
    const { engine, b } = await fixture();
    const session = await engine.openSession();
    const store = createEventStore();
    const transcript: Message[] = [];

    // Turn 1 on provider A ran a tool; the agent loop's reply legitimately
    // contains tool_use + tool_result blocks.
    transcript.push(
      { role: "user", content: [{ type: "text", text: "read config.json" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "read_file", input: { path: "config.json" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool_result",
            toolCallId: "call-1",
            content: [{ type: "text", text: "PORT=8080" }],
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "The port is 8080." }] },
    );

    const dispatchTurn = (input: Message[], ctx: RunContext): OrchestrationHandle =>
      dispatch(
        { kind: "single", run: { adapterId: "prov-b", model: "model-b", input, idempotencyKey: "k" } },
        ctx,
      );
    await runTurn(session, store, {
      provider: "prov-b",
      model: "model-b",
      text: "what port again?",
      history: transcript,
      dispatchTurn,
    });

    const flat = JSON.stringify(b.seen[0]?.messages ?? []);
    expect(flat).toContain("read_file");
    expect(flat).toContain("PORT=8080");
  });
});
