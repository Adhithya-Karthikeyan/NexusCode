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
  it("a provider switch carries the FULL tool exchange of a tool-using turn forward — tool_use, the tool's own result, and the final text", async () => {
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
    // this is the exact data `replyMessages` now threads onto the transcript.
    expect(outcome1.winner?.toolCalls.map((t) => t.name)).toEqual(["echo"]);
    expect(outcome1.winner?.text).toContain("echoed: PING");

    // The recorded turn is the whole exchange, not a single collapsed text
    // message: user prompt, the tool-call assistant message, the tool's own
    // result (paired back by toolCallId), and the final answer.
    const roles = session.transcript.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant"]);
    const toolMsg = session.transcript.find((m) => m.role === "tool");
    expect(toolMsg?.toolCallId).toBe(outcome1.winner?.toolCalls[0]?.id);

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

    // SURVIVES: the tool_use block that requested it, and the "tool" role
    // message carrying the result back — `beta` sees the real exchange, not a
    // synthesized text-only summary of it.
    const blockTypes = sentMessages.flatMap((m) => m.content.map((b: ContentBlock) => b.type));
    expect(blockTypes).toContain("tool_use");
    const toolRoleMsg = sentMessages.find((m) => m.role === "tool");
    expect(toolRoleMsg?.toolCallId).toBe(outcome1.winner?.toolCalls[0]?.id);

    await session.dispose();
    await engine.dispose();
  });
});
