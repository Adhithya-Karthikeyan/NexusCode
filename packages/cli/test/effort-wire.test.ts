/**
 * THE WIRE TEST for `--effort` (see `context-wire.test.ts` for the same method
 * applied to context assembly): a spy adapter captures the ACTUAL outgoing
 * `ChatRequest` from a real dispatch, so "the flag reaches the request" is
 * asserted against what genuinely left the process — not against an
 * intermediate object that could silently stop mattering.
 *
 * `reasoningParamsFor` (packages/cli/src/commands.ts) is the ONE function that
 * turns an `--effort` level into `SamplingParams.reasoning` — the exact same
 * function the TUI's `/effort` picker calls (`dispatchTurn` in `cmdTui`) and
 * `applyEffort` calls for every headless command (`ask`/`agent`/`chat`/
 * `compare`/`race`/`consensus`/`chain`/`code`/`plan`). This test proves that
 * value, once attached to `RunSpec.params.reasoning`, genuinely arrives on the
 * `ChatRequest` a provider's `stream()` receives — core's `specToRequest`
 * copies `params.reasoning` onto `req.reasoning` verbatim.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  ProviderRegistry,
  createEngine,
  dispatch,
  type ProviderAdapter,
} from "@nexuscode/core";
import type { ChatRequest } from "@nexuscode/shared";
import { createMockAdapter } from "@nexuscode/provider-mock";
import { reasoningParamsFor } from "../src/commands.js";

/** A reasoning-capable, http-sdk-transport adapter (like anthropic/openai/gemini/…) that records every outgoing request. */
function spyReasoningAdapter(): { adapter: ProviderAdapter; requests: ChatRequest[] } {
  const base = createMockAdapter({ id: "spy-reasoning" });
  const requests: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    ...base,
    transport: "http-sdk",
    capabilities: async () => ({ ...(await base.capabilities()), reasoning: true }),
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

async function dispatchOnce(
  registry: ProviderRegistry,
  reasoning: ReturnType<typeof reasoningParamsFor>,
): Promise<ChatRequest[]> {
  const requests: ChatRequest[] = [];
  const engine = createEngine({ registry });
  const session = await engine.openSession();
  const turn = session.newTurn({ prompt: "explain this" });
  const handle = dispatch(
    {
      kind: "single",
      run: {
        adapterId: "spy-reasoning",
        model: "mock-fast",
        input: turn.input,
        idempotencyKey: randomUUID(),
        ...(reasoning ? { params: { reasoning } } : {}),
      },
    },
    turn.context(),
  );
  for await (const _ of handle.events()) void _;
  turn.record(await handle.outcome());
  await session.dispose();
  await engine.dispose();
  return requests;
}

describe("--effort reaches the outgoing ChatRequest", () => {
  it.each([
    ["low", 4000],
    ["medium", 10000],
    ["high", 24000],
  ] as const)("'%s' arrives as reasoning.enabled=true, effort='%s', budgetTokens=%i", async (level, budget) => {
    const { adapter, requests } = spyReasoningAdapter();
    const registry = new ProviderRegistry();
    await registry.register(adapter, { skipHealth: true });

    await dispatchOnce(registry, reasoningParamsFor(level));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.reasoning).toEqual({ enabled: true, effort: level, budgetTokens: budget });
  });

  it("'off' attaches NO reasoning param at all — never a stale enabled:true", async () => {
    const { adapter, requests } = spyReasoningAdapter();
    const registry = new ProviderRegistry();
    await registry.register(adapter, { skipHealth: true });

    await dispatchOnce(registry, reasoningParamsFor("off"));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.reasoning).toBeUndefined();
  });

  /**
   * A provider-NATIVE level name (claude-code's "xhigh", codex's "ultra", …)
   * has no entry in NexusCode's own `EFFORT_BUDGET_TOKENS` table — that table
   * only covers the generic token-budget family (anthropic/gemini/vertex/
   * bedrock's shared "low"/"medium"/"high"). The old closed `EffortLevel`
   * union made this case unreachable entirely; now `effort` is a plain
   * `string`, so this proves the request still carries the level VERBATIM
   * with `budgetTokens` simply omitted — never a thrown error, never a
   * silently substituted generic level.
   */
  it("a provider-native level with no budget-token entry (e.g. 'xhigh') still arrives as reasoning.enabled=true, effort='xhigh', with budgetTokens OMITTED", async () => {
    const { adapter, requests } = spyReasoningAdapter();
    const registry = new ProviderRegistry();
    await registry.register(adapter, { skipHealth: true });

    await dispatchOnce(registry, reasoningParamsFor("xhigh"));

    expect(requests).toHaveLength(1);
    expect(requests[0]!.reasoning).toEqual({ enabled: true, effort: "xhigh" });
  });
});
