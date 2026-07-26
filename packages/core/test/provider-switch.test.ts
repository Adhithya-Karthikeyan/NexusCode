import { describe, expect, it } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  dispatch,
  type ContextAssembler,
  type OrchestrationOutcome,
  type ProviderAdapter,
  type Session,
  type TransferHandle,
} from "@nexuscode/core";
import { createMockAdapter } from "@nexuscode/provider-mock";
import type { ChatRequest } from "@nexuscode/shared";

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
});
