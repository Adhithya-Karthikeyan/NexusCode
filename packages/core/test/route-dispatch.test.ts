/**
 * `dispatchRoute` — the engine wiring that turns a declarative RouteRule into a
 * routed run with transparent live failover. Exercised entirely offline over the
 * mock / mock-flaky adapters: correct candidate selection, a clean single-run
 * outcome, and a cross-provider failover whose hand-off is visible on the
 * winning run-start's `raw.failover` trail.
 */

import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  dispatchRoute,
  selectRoute,
  chunkToUiEvents,
  type Engine,
  type FailoverEvent,
  type RunContext,
} from "@nexuscode/core";
import type { Message, StreamChunk } from "@nexuscode/shared";
import { createMockAdapter, createFlakyMockAdapter } from "@nexuscode/provider-mock";

async function newCtx(engine: Engine, prompt = "hello world"): Promise<{ ctx: RunContext; input: Message[] }> {
  const session = await engine.openSession();
  const turn = session.newTurn({ prompt });
  return { ctx: turn.context(), input: turn.input };
}

describe("dispatchRoute — selection", () => {
  it("routes to the explicit-ordered first candidate and settles a single run", async () => {
    const reg = new ProviderRegistry();
    await reg.register(createMockAdapter({ id: "a", models: ["mock-fast"] }));
    await reg.register(createMockAdapter({ id: "b", models: ["mock-fast"] }));
    const engine = createEngine({ registry: reg });
    const { ctx, input } = await newCtx(engine);

    const rule = { optimize: "explicit" as const, allow: ["b/mock-fast", "a/mock-fast"] };
    // selectRoute previews the order the run will use.
    const preview = selectRoute({ rule, input, idempotencyKey: "x" }, ctx);
    expect(preview[0]?.providerId).toBe("b");

    const handle = dispatchRoute({ rule, input, idempotencyKey: "x" }, ctx);
    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    expect(outcome.kind).toBe("single");
    expect(outcome.winner?.status).toBe("ok");
    expect(outcome.winner?.adapterId).toBe("b");
    expect(outcome.partial).toBe(false);

    await engine.dispose();
  });
});

describe("dispatchRoute — live failover", () => {
  it("fails over from an always-failing provider to a healthy one, with a visible trail", async () => {
    const reg = new ProviderRegistry();
    // "down" always emits a failover-eligible, non-retryable transport error, so
    // there is no same-provider retry/backoff — the router switches immediately.
    await reg.register(
      createFlakyMockAdapter({
        id: "down",
        models: ["mock-fast"],
        failCount: Number.POSITIVE_INFINITY,
        failCode: "transport",
        retryable: false,
      }),
    );
    await reg.register(createMockAdapter({ id: "up", models: ["mock-fast"] }));
    const engine = createEngine({ registry: reg });
    const { ctx, input } = await newCtx(engine);

    const failovers: FailoverEvent[] = [];
    const rule = { optimize: "explicit" as const, allow: ["down/mock-fast", "up/mock-fast"] };
    const handle = dispatchRoute(
      { rule, input, idempotencyKey: "f" },
      ctx,
      { onFailover: (e) => failovers.push(e) },
    );

    const chunks: StreamChunk[] = [];
    for await (const labeled of handle.events()) chunks.push(labeled.chunk);
    const outcome = await handle.outcome();

    // The healthy provider answered; the failed one never wins.
    expect(outcome.winner?.status).toBe("ok");
    expect(outcome.winner?.adapterId).toBe("up");

    // The hand-off fired and is recorded on the winning run-start's raw trail.
    expect(failovers).toHaveLength(1);
    expect(failovers[0]?.from.providerId).toBe("down");
    expect(failovers[0]?.to.providerId).toBe("up");

    const runStart = chunks.find((c) => c.type === "run-start");
    expect(runStart).toBeDefined();
    const uiEvents = chunkToUiEvents(runStart!, "main");
    const failoverEvent = uiEvents.find((e) => e.t === "failover");
    expect(failoverEvent).toMatchObject({ from: "down", to: "up", code: "transport" });

    await engine.dispose();
  });

  it("settles as a partial error when no candidate matches the rule", async () => {
    const reg = new ProviderRegistry();
    await reg.register(createMockAdapter({ id: "a", models: ["mock-fast"] }));
    const engine = createEngine({ registry: reg });
    const { ctx, input } = await newCtx(engine);

    const rule = { optimize: "explicit" as const, allow: ["nonexistent/model"] };
    const handle = dispatchRoute({ rule, input, idempotencyKey: "n" }, ctx);
    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    expect(outcome.winner).toBeUndefined();
    expect(outcome.partial).toBe(true);

    await engine.dispose();
  });
});
