import { describe, expect, it } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  dispatch,
  dispatchAgent,
  type ContextAssembler,
  type OrchestrationOutcome,
  type ProviderAdapter,
  type Session,
  type TransferHandle,
} from "@nexuscode/core";
import { createMockAdapter } from "@nexuscode/provider-mock";
import { PermissionGate, ToolRegistry, okText, type Tool } from "@nexuscode/tools";
import type { ChatRequest, ContentBlock } from "@nexuscode/shared";

function recordingAdapter(id: string): { adapter: ProviderAdapter; requests: ChatRequest[] } {
  const base = createMockAdapter({ id });
  const requests: ChatRequest[] = [];
  return {
    requests,
    adapter: {
      ...base,
      stream(req, ctx) {
        requests.push(structuredClone(req));
        return base.stream(req, ctx);
      },
    },
  };
}

async function run(
  session: Session,
  provider: string,
  prompt: string,
): Promise<OrchestrationOutcome> {
  const turn = session.newTurn({ prompt });
  const handle = dispatch(
    {
      kind: "single",
      run: {
        adapterId: provider,
        model: "mock-fast",
        input: turn.input,
        idempotencyKey: `${provider}-${prompt}`,
        params: { system: "BASE_SYSTEM" },
      },
    },
    turn.context(),
  );
  for await (const _ of handle.events()) {
    /* drain */
  }
  const outcome = await handle.outcome();
  turn.record(outcome);
  return outcome;
}

describe("provider switching — shared conversation, context, and transfer", () => {
  it("hands a new provider the prior conversation and the same assembled project context", async () => {
    const alpha = recordingAdapter("alpha");
    const beta = recordingAdapter("beta");
    const registry = new ProviderRegistry();
    await registry.register(alpha.adapter, { skipHealth: true });
    await registry.register(beta.adapter, { skipHealth: true });

    const assembler: ContextAssembler = {
      async assemble(input) {
        return {
          messages: input.messages,
          system: `${input.system ?? ""}\nPROJECT_CONTEXT:NexusCode`,
        };
      },
    };
    const identities: string[] = [];
    let captured = 0;
    const engine = createEngine({
      registry,
      contextAssembler: assembler,
      transferFactory(identity) {
        identities.push(identity.runId);
        const handle: TransferHandle = {
          sessionId: identity.sessionId,
          captureVerbatim() {
            captured++;
          },
          async project() {},
          recordToolOutput() {},
          async turnBoundary() {},
          flush() {},
        };
        return handle;
      },
    });

    const session = await engine.openSession();
    await run(session, "alpha", "The migration key is cobalt.");
    await run(session, "beta", "Continue the same project.");

    expect(alpha.requests).toHaveLength(1);
    expect(beta.requests).toHaveLength(1);
    expect(beta.requests[0]!.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(beta.requests[0]!.messages)).toContain("migration key is cobalt");
    expect(beta.requests[0]!.system).toContain("BASE_SYSTEM");
    expect(beta.requests[0]!.system).toContain("PROJECT_CONTEXT:NexusCode");

    // One independent transfer handle per provider run, with every normalized
    // provider chunk captured on the ordinary (non-agent) dispatch path.
    expect(identities).toHaveLength(2);
    expect(new Set(identities).size).toBe(2);
    expect(captured).toBeGreaterThan(0);

    await session.dispose();
    await engine.dispose();
  });

  // § CAPABILITIES.md G5 — pinning what a provider switch actually preserves,
  // rather than assuming the receipt's `preserved` list ("conversation
  // transcript", …) means tool-call history round-trips it. It does not, and
  // this is not switch-specific: `replyMessages` (`../src/engine.ts`) already
  // collapses EVERY turn's reply to its final text — discarding
  // `RunResult.toolCalls` — before it ever reaches `session.transcript`, on
  // every turn boundary, switch or not. A switch (via `assessSwitchTarget`/
  // `adaptRequestForSwitch`, or the naive `dispatch()`-with-a-different-
  // -adapterId this file already exercises above) operates on that transcript
  // AS IT ALREADY IS; it cannot hand a new provider tool-call context that was
  // never written down.
  it("a provider switch carries the FINAL TEXT of a tool-using turn forward, but never the tool call/result content — this is the actual, current guarantee, not a full replay", async () => {
    const echoTool: Tool = {
      name: "echo",
      description: "Echo the given text back.",
      permission: "read",
      parameters: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      async run(input) {
        const text = (input as { text?: string }).text ?? "";
        return okText(`echoed: ${text}`);
      },
    };

    const alpha = createMockAdapter({ id: "alpha", toolName: "echo", toolInput: (p) => ({ text: p }) });
    const beta = recordingAdapter("beta");
    const registry = new ProviderRegistry();
    await registry.register(alpha, { skipHealth: true });
    await registry.register(beta.adapter, { skipHealth: true });

    const engine = createEngine({ registry });
    const session = await engine.openSession();

    // Turn 1, on `alpha`: the native tool loop actually calls `echo`.
    const tools = new ToolRegistry();
    tools.register(echoTool);
    const turn1 = session.newTurn({ prompt: "PING" });
    const handle = dispatchAgent(
      { adapterId: "alpha", model: "mock-tools", input: turn1.input, idempotencyKey: "switch-t1" },
      turn1.context(),
      { tools, gate: new PermissionGate({ mode: "full-access" }) },
    );
    for await (const _ of handle.events()) {
      /* drain */
    }
    const outcome1 = await handle.outcome();
    turn1.record(outcome1);

    // Confirmed the tool genuinely ran and the run captured it structurally —
    // this is the exact data `replyMessages` has available and does not use.
    expect(outcome1.winner?.toolCalls.map((t) => t.name)).toEqual(["echo"]);
    expect(outcome1.winner?.text).toContain("echoed: PING");

    // Turn 2, switched to `beta` (a plain, non-agent dispatch — same shape
    // `performSwitch`'s next `runTurn` would issue): inspect exactly what the
    // NEW provider received.
    const turn2 = session.newTurn({ prompt: "continue" });
    const handle2 = dispatch(
      {
        kind: "single",
        run: { adapterId: "beta", model: "mock-fast", input: turn2.input, idempotencyKey: "switch-t2" },
      },
      turn2.context(),
    );
    for await (const _ of handle2.events()) {
      /* drain */
    }
    const outcome2 = await handle2.outcome();
    turn2.record(outcome2);

    expect(beta.requests).toHaveLength(1);
    const sentMessages = beta.requests[0]!.messages;

    // SURVIVES: the final text answer from the tool-using turn.
    expect(JSON.stringify(sentMessages)).toContain("echoed: PING");

    // DOES NOT SURVIVE: no `tool_use`/`tool_result` content block anywhere in
    // what the new provider received — the tool call is genuinely gone, not
    // merely hidden from this assertion by shape.
    const blockTypes = sentMessages.flatMap((m) => m.content.map((b: ContentBlock) => b.type));
    expect(blockTypes).not.toContain("tool_use");
    expect(blockTypes).not.toContain("tool_result");
    // Every message the new provider sees is plain text — that IS the
    // "conversation transcript" a switch receipt claims to preserve.
    expect(new Set(blockTypes)).toEqual(new Set(["text"]));

    await session.dispose();
    await engine.dispose();
  });
});
