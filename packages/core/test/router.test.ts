import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  Router,
  runWithFailover,
  registryRunFactory,
  isFailoverEligible,
  isLocalProvider,
  chunkToUiEvents,
  rootScope,
  DEFAULT_RETRY_POLICY,
  type RouteCandidate,
  type FailoverEvent,
  type CallContext,
  type ProviderAdapter,
} from "@nexuscode/core";
import type { ChatRequest, Message, StreamChunk } from "@nexuscode/shared";
import { AdapterError } from "@nexuscode/shared";
import { createMockAdapter, createFlakyMockAdapter } from "@nexuscode/provider-mock";

const MSGS: Message[] = [{ role: "user", content: [{ type: "text", text: "hello world" }] }];

function ctxFor(runId: string, signal: AbortSignal): CallContext {
  return { signal, idempotencyKey: `idem_${runId}`, traceId: "trace", runId };
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of stream) out.push(c);
  return out;
}

/** Register a mock adapter carrying a single model id, forcing a chosen health. */
async function registerModel(
  reg: ProviderRegistry,
  id: string,
  model: string,
  health: { ok: boolean } = { ok: true },
): Promise<void> {
  const base = createMockAdapter({ id, models: [model] });
  const adapter: ProviderAdapter = { ...base, health: async () => health };
  await reg.register(adapter);
}

describe("Router.select — ordering by optimize axis", () => {
  it("orders by ascending total cost", async () => {
    const reg = new ProviderRegistry();
    await registerModel(reg, "pricey", "big");
    await registerModel(reg, "cheap", "small");
    await registerModel(reg, "mid", "medium");

    const router = new Router({
      pricing: {
        big: { inputPerMTok: 15, outputPerMTok: 75 },
        medium: { inputPerMTok: 3, outputPerMTok: 15 },
        small: { inputPerMTok: 0.25, outputPerMTok: 1.25 },
      },
    });

    const candidates = router.select({ optimize: "cost" }, { registry: reg });
    expect(candidates.map((c) => c.modelId)).toEqual(["small", "medium", "big"]);
    expect(candidates.every((c) => c.reason === "cost")).toBe(true);
  });

  it("orders by ascending latency; unknown latency sorts last", async () => {
    const reg = new ProviderRegistry();
    await registerModel(reg, "slow", "slow-m");
    await registerModel(reg, "fast", "fast-m");
    await registerModel(reg, "unknown", "unknown-m");

    const router = new Router({ latency: { "fast-m": 120, "slow-m": 900 } });
    const candidates = router.select({ optimize: "latency" }, { registry: reg });
    expect(candidates.map((c) => c.modelId)).toEqual(["fast-m", "slow-m", "unknown-m"]);
  });

  it("puts local providers first for optimize:local", async () => {
    const reg = new ProviderRegistry();
    await registerModel(reg, "openai", "gpt");
    await registerModel(reg, "ollama", "llama");
    await registerModel(reg, "anthropic", "claude");

    expect(isLocalProvider("ollama")).toBe(true);
    expect(isLocalProvider("openai")).toBe(false);

    const router = new Router();
    const candidates = router.select({ optimize: "local" }, { registry: reg });
    expect(candidates[0]?.providerId).toBe("ollama");
    expect(candidates[0]?.reason).toBe("local");
  });

  it("orders by configured quality ranking", async () => {
    const reg = new ProviderRegistry();
    await registerModel(reg, "a", "a-m");
    await registerModel(reg, "b", "b-m");
    await registerModel(reg, "c", "c-m");

    const router = new Router({ quality: ["c-m", "a-m", "b-m"] });
    const candidates = router.select({ optimize: "quality" }, { registry: reg });
    expect(candidates.map((c) => c.modelId)).toEqual(["c-m", "a-m", "b-m"]);
  });

  it("honors explicit order (allow) and appends the fallback chain", async () => {
    const reg = new ProviderRegistry();
    await registerModel(reg, "primary", "p-m");
    await registerModel(reg, "secondary", "s-m");
    await registerModel(reg, "backup", "b-m");

    const router = new Router();
    const candidates = router.select(
      { optimize: "explicit", allow: ["secondary", "primary"], fallback: ["backup"] },
      { registry: reg },
    );
    expect(candidates.map((c) => c.providerId)).toEqual(["secondary", "primary", "backup"]);
    expect(candidates[0]?.reason).toBe("explicit");
    expect(candidates[2]?.reason).toBe("fallback");
  });

  it("applies deny and capability filters, and drops known-unhealthy providers", async () => {
    const reg = new ProviderRegistry();
    await registerModel(reg, "good", "good-m");
    await registerModel(reg, "denied", "denied-m");
    await registerModel(reg, "down", "down-m", { ok: false }); // unhealthy → excluded

    const router = new Router();

    // deny removes the named provider.
    const denied = router.select({ optimize: "explicit", deny: ["denied"] }, { registry: reg });
    expect(denied.map((c) => c.providerId).sort()).toEqual(["good"]);

    // unhealthy provider never appears.
    const all = router.select({ optimize: "explicit" }, { registry: reg });
    expect(all.map((c) => c.providerId)).not.toContain("down");

    // capability predicate drops chat-only mocks when a coding power is required.
    const needsFileEdit = router.select(
      { optimize: "explicit" },
      { registry: reg, capabilitiesNeeded: (c) => c.fileEdit },
    );
    expect(needsFileEdit).toHaveLength(0);
  });
});

describe("runWithFailover — live failover", () => {
  it("classifies which errors are failover-eligible", () => {
    expect(isFailoverEligible(new AdapterError("overloaded", "x"))).toBe(true);
    expect(isFailoverEligible(new AdapterError("rate_limit", "x"))).toBe(true);
    expect(isFailoverEligible(new AdapterError("transport", "x"))).toBe(true);
    expect(isFailoverEligible(new AdapterError("cli_exit", "x"))).toBe(true); // retryable:false by default, still eligible
    expect(isFailoverEligible(new AdapterError("auth", "x"))).toBe(false);
    expect(isFailoverEligible(new AdapterError("cancelled", "x"))).toBe(false);
  });

  it("switches from an always-failing provider to a healthy one and emits a visible signal", async () => {
    const scope = rootScope();
    const fast = createMockAdapter({ id: "fast", models: ["mock-fast"] });

    // Candidate A always fails before any content (like mock-flaky failCount=∞).
    async function* alwaysFail(runId: string, model: string): AsyncIterable<StreamChunk> {
      yield { type: "run-start", runId, adapterId: "flaky", model, ts: Date.now() };
      yield {
        type: "error",
        runId,
        error: new AdapterError("overloaded", "flaky always fails", { providerId: "flaky", retryable: true }),
        retryable: true,
      };
    }

    const candidates: RouteCandidate[] = [
      { providerId: "flaky", modelId: "mock-fast", reason: "cost" },
      { providerId: "fast", modelId: "mock-fast", reason: "fallback" },
    ];

    const failovers: FailoverEvent[] = [];
    const makeRun = (c: RouteCandidate): AsyncIterable<StreamChunk> => {
      const runId = `run_${c.providerId}`;
      if (c.providerId === "flaky") return alwaysFail(runId, c.modelId);
      const req: ChatRequest = { model: c.modelId, messages: MSGS };
      return fast.stream(req, ctxFor(runId, scope.signal));
    };

    const chunks = await drain(
      runWithFailover(candidates, makeRun, scope, { onFailover: (e) => failovers.push(e) }),
    );

    // The hand-off fired exactly once, from flaky → fast.
    expect(failovers).toHaveLength(1);
    expect(failovers[0]?.from.providerId).toBe("flaky");
    expect(failovers[0]?.to.providerId).toBe("fast");
    expect(failovers[0]?.error.code).toBe("overloaded");

    // No terminal error survived — the losing candidate emitted nothing.
    expect(chunks.some((c) => c.type === "error")).toBe(false);
    const runStarts = chunks.filter((c) => c.type === "run-start");
    expect(runStarts).toHaveLength(1); // only the winner's run-start

    // The stream ends with a clean run-end from the winner.
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("run-end");
    if (last?.type === "run-end") expect(last.finishReason).toBe("stop");

    // Winner content is the mock-fast echo.
    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: "text-delta" }> => c.type === "text-delta")
      .map((c) => c.text)
      .join("");
    expect(text).toBe("[mock-fast] Echo: hello world");

    // The failover trail is stamped onto the winner's run-start and projects to
    // a visible `failover` UiEvent for the TUI.
    const winnerStart = runStarts[0]!;
    const ui = chunkToUiEvents(winnerStart, "main");
    const failoverUi = ui.filter((e) => e.t === "failover");
    expect(failoverUi).toHaveLength(1);
    expect(failoverUi[0]).toMatchObject({ t: "failover", from: "flaky", to: "fast" });
    // The session banner still follows the failover event.
    expect(ui.some((e) => e.t === "session")).toBe(true);
  });

  it("does NOT fail over once streaming has begun — a mid-stream error is terminal", async () => {
    const scope = rootScope();
    const secondCandidateUsed = { value: false };

    // Candidate A emits real content, THEN fails. Failover must not fire.
    async function* streamThenFail(runId: string, model: string): AsyncIterable<StreamChunk> {
      yield { type: "run-start", runId, adapterId: "streamer", model, ts: Date.now() };
      yield { type: "text-delta", runId, text: "partial answer ", channel: "answer" };
      yield {
        type: "error",
        runId,
        error: new AdapterError("overloaded", "late failure after content", { retryable: true }),
        retryable: true,
      };
    }

    async function* neverReached(runId: string, model: string): AsyncIterable<StreamChunk> {
      secondCandidateUsed.value = true;
      yield { type: "run-start", runId, adapterId: "backup", model, ts: Date.now() };
      yield { type: "text-delta", runId, text: "backup answer", channel: "answer" };
      yield {
        type: "run-end",
        runId,
        finishReason: "stop",
        message: { role: "assistant", content: [{ type: "text", text: "backup answer" }] },
        ts: Date.now(),
      };
    }

    const candidates: RouteCandidate[] = [
      { providerId: "streamer", modelId: "m", reason: "cost" },
      { providerId: "backup", modelId: "m", reason: "fallback" },
    ];

    const failovers: FailoverEvent[] = [];
    const makeRun = (c: RouteCandidate): AsyncIterable<StreamChunk> =>
      c.providerId === "streamer" ? streamThenFail(`run_${c.providerId}`, c.modelId) : neverReached(`run_${c.providerId}`, c.modelId);

    const chunks = await drain(
      runWithFailover(candidates, makeRun, scope, { onFailover: (e) => failovers.push(e) }),
    );

    // Failover did not fire, the backup candidate was never invoked.
    expect(failovers).toHaveLength(0);
    expect(secondCandidateUsed.value).toBe(false);

    // Partial content streamed, then the mid-stream error is the terminal chunk.
    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: "text-delta" }> => c.type === "text-delta")
      .map((c) => c.text)
      .join("");
    expect(text).toBe("partial answer ");
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type === "error") expect(last.error.code).toBe("overloaded");
    // The backup answer never leaked into the stream.
    expect(text).not.toContain("backup");
  });

  it("wires through the registry via registryRunFactory (flaky → healthy, offline)", async () => {
    const scope = rootScope();
    const reg = new ProviderRegistry();
    await reg.register(createFlakyMockAdapter({ id: "flaky", failCount: Infinity, models: ["mock-fast"] }));
    await reg.register(createMockAdapter({ id: "healthy", models: ["mock-fast"] }));

    const candidates: RouteCandidate[] = [
      { providerId: "flaky", modelId: "mock-fast", reason: "cost" },
      { providerId: "healthy", modelId: "mock-fast", reason: "fallback" },
    ];

    // No same-provider retries (maxAttempts:1) so the flaky provider fails once
    // and failover switches immediately — keeps the offline test fast.
    const policy = { ...DEFAULT_RETRY_POLICY, maxAttempts: 1 };
    const factory = registryRunFactory(
      reg,
      (c, adapter) => adapter.stream({ model: c.modelId, messages: MSGS }, ctxFor(`run_${c.providerId}`, scope.signal)),
      scope,
      policy,
    );

    const failovers: FailoverEvent[] = [];
    const chunks = await drain(runWithFailover(candidates, factory, scope, { onFailover: (e) => failovers.push(e) }));

    expect(failovers).toHaveLength(1);
    expect(failovers[0]?.to.providerId).toBe("healthy");
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("run-end");
    const text = chunks
      .filter((c): c is Extract<StreamChunk, { type: "text-delta" }> => c.type === "text-delta")
      .map((c) => c.text)
      .join("");
    expect(text).toBe("[mock-fast] Echo: hello world");
  });

  it("skips candidates flagged unhealthy at dispatch time via isHealthy", async () => {
    const scope = rootScope();
    const fast = createMockAdapter({ id: "fast", models: ["mock-fast"] });

    const candidates: RouteCandidate[] = [
      { providerId: "down", modelId: "mock-fast", reason: "cost" },
      { providerId: "fast", modelId: "mock-fast", reason: "fallback" },
    ];

    let downInvoked = false;
    const makeRun = (c: RouteCandidate): AsyncIterable<StreamChunk> => {
      if (c.providerId === "down") {
        downInvoked = true;
        // Should never run — filtered by isHealthy.
        return fast.stream({ model: c.modelId, messages: MSGS }, ctxFor("run_down", scope.signal));
      }
      return fast.stream({ model: c.modelId, messages: MSGS }, ctxFor("run_fast", scope.signal));
    };

    const chunks = await drain(
      runWithFailover(candidates, makeRun, scope, { isHealthy: (c) => c.providerId !== "down" }),
    );

    expect(downInvoked).toBe(false);
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("run-end");
  });

  it("yields a single terminal error when every candidate fails over", async () => {
    const scope = rootScope();
    async function* fail(runId: string, provider: string): AsyncIterable<StreamChunk> {
      yield { type: "run-start", runId, adapterId: provider, model: "m", ts: Date.now() };
      yield {
        type: "error",
        runId,
        error: new AdapterError("overloaded", `${provider} down`, { providerId: provider, retryable: true }),
        retryable: true,
      };
    }
    const candidates: RouteCandidate[] = [
      { providerId: "a", modelId: "m", reason: "cost" },
      { providerId: "b", modelId: "m", reason: "fallback" },
    ];
    const makeRun = (c: RouteCandidate): AsyncIterable<StreamChunk> => fail(`run_${c.providerId}`, c.providerId);

    const failovers: FailoverEvent[] = [];
    const chunks = await drain(runWithFailover(candidates, makeRun, scope, { onFailover: (e) => failovers.push(e) }));

    expect(failovers).toHaveLength(1); // a → b
    const errors = chunks.filter((c) => c.type === "error");
    expect(errors).toHaveLength(1); // exactly one terminal error
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("error");
  });
});
