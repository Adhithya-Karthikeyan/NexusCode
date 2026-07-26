/**
 * Model-aware conversation-history budget.
 *
 * `HistoryOptions.maxTokens` used to be a single number resolved when the
 * session opened, defaulting to a flat 32k. Measured against a 1,000,000-token
 * model that kept only ~12 of 40 turns — roughly 3% of the usable window — and
 * on a small model it overflowed instead of trimming. A callback-valued budget
 * is re-read every turn, so it tracks the ACTIVE provider/model and follows a
 * live `/model` or `/provider` switch in both directions.
 */
import { describe, it, expect } from "vitest";
import { ProviderRegistry, createEngine, dispatch, type ChatRequest, type ProviderAdapter } from "../src/index.js";
import { createMockAdapter } from "@nexuscode/provider-mock";

/**
 * A recording adapter whose model declares a DELIBERATELY huge context window.
 * The request-level compaction (`adaptRequestForSwitch`) also trims to the
 * model's window; keeping that window effectively unlimited isolates the history
 * budget as the only thing under test.
 */
function recording(id: string, model: string, contextWindow = 5_000_000) {
  const base = createMockAdapter({ id, models: [model] });
  const seen: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    ...base,
    capabilities: async (signal) => {
      const caps = await base.capabilities(signal);
      return { ...caps, models: [{ id: model, contextWindow }] };
    },
    stream(request, context) {
      seen.push(request);
      return base.stream(request, context);
    },
  };
  return { adapter, seen };
}

/** ~2,000 estimated tokens per turn (the estimator is chars/4). */
const CHUNK = "x".repeat(8_000);

async function converse(
  budget: number | (() => number),
  turns: number,
): Promise<{ seen: ChatRequest[] }> {
  const registry = new ProviderRegistry();
  const p = recording("p", "m");
  await registry.register(p.adapter, { skipHealth: true });
  const engine = createEngine({ registry, history: { maxTokens: budget } });
  const session = await engine.openSession();

  for (let i = 0; i < turns; i++) {
    const turn = session.newTurn({ prompt: `turn-${i} ${CHUNK}` });
    const handle = dispatch(
      {
        kind: "single",
        run: { adapterId: "p", model: "m", input: turn.input, idempotencyKey: `k${i}` },
      },
      turn.context(),
    );
    for await (const _ of handle.events()) {
      /* drain */
    }
    turn.record(await handle.outcome());
  }
  return p;
}

function userTurnsIn(request: ChatRequest): number {
  return request.messages.filter((m) =>
    m.content.some((b) => b.type === "text" && b.text.startsWith("turn-")),
  ).length;
}

describe("history budget follows the active model", () => {
  it("keeps FAR more history on a large window than the flat 32k default did", async () => {
    const small = await converse(32_000, 40);
    const large = await converse(700_000, 40);

    const smallKept = userTurnsIn(small.seen.at(-1)!);
    const largeKept = userTurnsIn(large.seen.at(-1)!);

    // The old flat ceiling dropped most of a 40-turn conversation…
    expect(smallKept).toBeLessThan(20);
    // …while a budget derived from a big model's window keeps all of it.
    expect(largeKept).toBe(40);
    expect(largeKept).toBeGreaterThan(smallKept);
  });

  it("re-reads a callback budget every turn, so a mid-session switch takes effect", async () => {
    const registry = new ProviderRegistry();
    const p = recording("p", "m");
    await registry.register(p.adapter, { skipHealth: true });

    // Starts wide (a 1M-token model), then the user switches to a small one.
    let budget = 700_000;
    const engine = createEngine({ registry, history: { maxTokens: () => budget } });
    const session = await engine.openSession();

    const send = async (i: number): Promise<void> => {
      const turn = session.newTurn({ prompt: `turn-${i} ${CHUNK}` });
      const handle = dispatch(
        {
          kind: "single",
          run: { adapterId: "p", model: "m", input: turn.input, idempotencyKey: `k${i}` },
        },
        turn.context(),
      );
      for await (const _ of handle.events()) {
        /* drain */
      }
      turn.record(await handle.outcome());
    };

    for (let i = 0; i < 20; i++) await send(i);
    const wide = userTurnsIn(p.seen.at(-1)!);
    expect(wide).toBe(20);

    // `/model` → a much smaller context window.
    budget = 20_000;
    await send(20);
    const narrow = userTurnsIn(p.seen.at(-1)!);

    // The transcript was trimmed BEFORE the request rather than overflowing.
    expect(narrow).toBeLessThan(wide);
    expect(narrow).toBeGreaterThan(0);
  });

  it("falls back to the default when the callback throws or returns nonsense", async () => {
    const boom = await converse(() => {
      throw new Error("registry gone");
    }, 6);
    const nonsense = await converse(() => Number.NaN, 6);
    // Both still produce a valid, bounded request instead of crashing the turn.
    expect(boom.seen.at(-1)!.messages.length).toBeGreaterThan(0);
    expect(nonsense.seen.at(-1)!.messages.length).toBeGreaterThan(0);
  });
});
