import { describe, expect, it } from "vitest";
import {
  AdapterError,
  ProviderCircuitBreaker,
  ProviderRegistry,
  Router,
  createEngine,
  dispatch,
  dispatchAgent,
  rootScope,
  runWithFailover,
  type ChatRequest,
  type OrchestrationHandle,
  type ProviderAdapter,
  type RouteCandidate,
  type StreamChunk,
} from "@nexuscode/core";
import { createMockAdapter } from "@nexuscode/provider-mock";
import { PermissionGate, ToolRegistry } from "@nexuscode/tools";

async function settle(handle: OrchestrationHandle): Promise<Awaited<ReturnType<OrchestrationHandle["outcome"]>>> {
  for await (const _event of handle.events()) {
    // Drain the live stream before reading the settled result.
  }
  return handle.outcome();
}

async function drain(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

describe("reliability features — integrated kernel behavior", () => {
  it("orders blocked circuit targets last but retains an all-blocked diagnosis", async () => {
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ id: "spent", models: ["m-spent"] }), {
      skipHealth: true,
    });
    await registry.register(createMockAdapter({ id: "healthy", models: ["m-healthy"] }), {
      skipHealth: true,
    });
    const circuit = new ProviderCircuitBreaker({ quotaCooldownMs: 60_000 });
    circuit.recordFailure(
      { providerId: "spent", modelId: "m-spent" },
      new AdapterError("quota_exhausted", "usage limit", { providerId: "spent" }),
    );
    const router = new Router();
    const candidates = router.select(
      { optimize: "explicit", allow: ["spent", "healthy"] },
      { registry, providerCircuit: circuit },
    );
    expect(candidates.map((candidate) => candidate.providerId)).toEqual(["healthy", "spent"]);

    const onlySpent = router.select(
      { optimize: "explicit", allow: ["spent"] },
      { registry, providerCircuit: circuit },
    );
    expect(onlySpent).toHaveLength(1);
    expect(onlySpent[0]?.providerId).toBe("spent");
  });

  it("applies a provider circuit to direct engine runs, not only routed runs", async () => {
    let providerCalls = 0;
    const base = createMockAdapter({ id: "spent", models: ["m"] });
    const spent: ProviderAdapter = {
      ...base,
      stream(_request, ctx) {
        providerCalls += 1;
        return (async function* (): AsyncIterable<StreamChunk> {
          yield {
            type: "run-start",
            runId: ctx.runId,
            adapterId: "spent",
            model: "m",
            ts: 1,
          };
          const error = new AdapterError("quota_exhausted", "monthly usage limit expired", {
            providerId: "spent",
          });
          yield { type: "error", runId: ctx.runId, error, retryable: false };
        })();
      },
    };
    const registry = new ProviderRegistry();
    await registry.register(spent, { skipHealth: true });
    let now = 1_000;
    const circuit = new ProviderCircuitBreaker({
      now: () => now,
      transientFailureThreshold: 1,
      quotaCooldownMs: 60_000,
    });
    const engine = createEngine({ registry, providerCircuit: circuit });
    const session = await engine.openSession();

    const firstTurn = session.newTurn({ prompt: "first" });
    const first = await settle(
      dispatch(
        {
          kind: "single",
          run: {
            adapterId: "spent",
            model: "m",
            input: firstTurn.input,
            idempotencyKey: "first",
          },
        },
        firstTurn.context(),
      ),
    );
    firstTurn.record(first);
    expect(first.runs[0]?.error?.code).toBe("quota_exhausted");
    expect(providerCalls).toBe(1);

    now += 1;
    const secondTurn = session.newTurn({ prompt: "second" });
    const second = await settle(
      dispatch(
        {
          kind: "single",
          run: {
            adapterId: "spent",
            model: "m",
            input: secondTurn.input,
            idempotencyKey: "second",
          },
        },
        secondTurn.context(),
      ),
    );
    secondTurn.record(second);
    expect(second.runs[0]?.error?.code).toBe("quota_exhausted");
    expect(second.runs[0]?.error?.message).toContain("temporarily unavailable");
    expect(providerCalls).toBe(1);
  });

  it("injects a handoff system message on an explicit live provider switch", async () => {
    const registry = new ProviderRegistry();
    const a = createMockAdapter({ id: "a", models: ["m-a"] });
    const bBase = createMockAdapter({ id: "b", models: ["m-b"] });
    const bRequests: ChatRequest[] = [];
    const b: ProviderAdapter = {
      ...bBase,
      stream(request, context) {
        bRequests.push(request);
        return bBase.stream(request, context);
      },
    };
    await registry.register(a, { skipHealth: true });
    await registry.register(b, { skipHealth: true });
    const engine = createEngine({
      registry,
      handoffBuilder: (input) => ({
        role: "system",
        name: "nexus-provider-handoff",
        content: [
          {
            type: "text",
            text: `same-project:${input.fromProviderId}->${input.toProviderId}`,
          },
        ],
      }),
    });
    const session = await engine.openSession();

    const firstTurn = session.newTurn({ prompt: "Remember project Aurora" });
    const first = await settle(
      dispatch(
        {
          kind: "single",
          run: {
            adapterId: "a",
            model: "m-a",
            input: firstTurn.input,
            idempotencyKey: "a",
          },
        },
        firstTurn.context(),
      ),
    );
    firstTurn.record(first);

    const secondTurn = session.newTurn({ prompt: "Continue it" });
    const second = await settle(
      dispatch(
        {
          kind: "single",
          run: {
            adapterId: "b",
            model: "m-b",
            input: secondTurn.input,
            idempotencyKey: "b",
          },
        },
        secondTurn.context(),
      ),
    );
    secondTurn.record(second);

    expect(bRequests).toHaveLength(1);
    expect(bRequests[0]?.messages[0]).toMatchObject({
      role: "system",
      name: "nexus-provider-handoff",
      content: [{ type: "text", text: "same-project:a->b" }],
    });
    expect(
      bRequests[0]?.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.some(
            (block) => block.type === "text" && block.text === "Remember project Aurora",
          ),
      ),
    ).toBe(true);
  });

  it("fails over a native agent turn with a handoff and reports the actual winner", async () => {
    const exhaustedBase = createMockAdapter({ id: "exhausted", models: ["m-a"] });
    const exhausted: ProviderAdapter = {
      ...exhaustedBase,
      stream(_request, context) {
        return (async function* (): AsyncIterable<StreamChunk> {
          yield {
            type: "run-start",
            runId: context.runId,
            adapterId: "exhausted",
            model: "m-a",
            ts: 1,
          };
          const error = new AdapterError("quota_exhausted", "plan limit expired", {
            providerId: "exhausted",
          });
          yield { type: "error", runId: context.runId, error, retryable: false };
        })();
      },
    };
    const backupBase = createMockAdapter({ id: "backup", models: ["m-b"] });
    const backupRequests: ChatRequest[] = [];
    const backup: ProviderAdapter = {
      ...backupBase,
      stream(request, context) {
        backupRequests.push(structuredClone(request));
        return backupBase.stream(request, context);
      },
    };
    const registry = new ProviderRegistry();
    await registry.register(exhausted, { skipHealth: true });
    await registry.register(backup, { skipHealth: true });
    const traces: string[] = [];
    const engine = createEngine({
      registry,
      switching: {
        policy: "fallback",
        maxFallbacks: 1,
        preferredProviders: ["backup"],
      },
      handoffBuilder: (input) => ({
        role: "system",
        name: "nexus-provider-handoff",
        content: [
          {
            type: "text",
            text: `capsule:${input.fromProviderId}->${input.toProviderId}`,
          },
        ],
      }),
      emit: (event) => traces.push(event.type),
    });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "continue project" });
    const handle = dispatchAgent(
      {
        adapterId: "exhausted",
        model: "m-a",
        input: turn.input,
        idempotencyKey: "agent-failover",
      },
      turn.context(),
      {
        tools: new ToolRegistry(),
        gate: new PermissionGate({ mode: "read-only" }),
      },
    );
    const outcome = await settle(handle);

    expect(outcome.winner).toMatchObject({
      adapterId: "backup",
      model: "m-b",
      status: "ok",
    });
    expect(JSON.stringify(backupRequests[0]?.messages)).toContain("capsule:exhausted->backup");
    expect(traces).toContain("provider-switch");
  });

  it("safely continues a partial text response and removes repeated overlap", async () => {
    const candidates: RouteCandidate[] = [
      { providerId: "a", modelId: "m", reason: "explicit" },
      { providerId: "b", modelId: "m", reason: "fallback" },
    ];
    const recoveries: string[] = [];
    const failovers: Array<{ recovered: boolean }> = [];
    const chunks = await drain(
      runWithFailover(
        candidates,
        (candidate, recovery) => {
          if (candidate.providerId === "a") {
            return (async function* (): AsyncIterable<StreamChunk> {
              yield { type: "run-start", runId: "r", adapterId: "a", model: "m", ts: 1 };
              yield { type: "text-delta", runId: "r", text: "The answer is hel" };
              const error = new AdapterError("transport", "socket reset", { retryable: true });
              yield { type: "error", runId: "r", error, retryable: true };
            })();
          }
          recoveries.push(recovery?.serializedEnvelope ?? "");
          return (async function* (): AsyncIterable<StreamChunk> {
            yield { type: "run-start", runId: "r", adapterId: "b", model: "m", ts: 2 };
            yield { type: "text-delta", runId: "r", text: "The answer is hello world" };
            yield {
              type: "run-end",
              runId: "r",
              finishReason: "stop",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "The answer is hello world" }],
              },
              ts: 3,
            };
          })();
        },
        rootScope(),
        {
          partialRecovery: { enabled: true, originalGoal: "answer the question" },
          onFailover: (event) => failovers.push({ recovered: event.partialRecovery !== undefined }),
        },
      ),
    );

    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toContain("nexus.partial-recovery.v1");
    expect(failovers).toEqual([{ recovered: true }]);
    expect(chunks.filter((chunk) => chunk.type === "run-start")).toHaveLength(1);
    expect(
      chunks
        .filter((chunk): chunk is Extract<StreamChunk, { type: "text-delta" }> => chunk.type === "text-delta")
        .map((chunk) => chunk.text)
        .join(""),
    ).toBe("The answer is hello world");
    expect(chunks.at(-1)?.type).toBe("run-end");
  });

  it("refuses partial continuation after an unapproved mutation", async () => {
    const candidates: RouteCandidate[] = [
      { providerId: "a", modelId: "m", reason: "explicit" },
      { providerId: "b", modelId: "m", reason: "fallback" },
    ];
    let backupInvoked = false;
    const decisions: string[] = [];
    const chunks = await drain(
      runWithFailover(
        candidates,
        (candidate) => {
          if (candidate.providerId === "b") {
            backupInvoked = true;
            return (async function* (): AsyncIterable<StreamChunk> {
              yield { type: "run-start", runId: "r", adapterId: "b", model: "m", ts: 2 };
            })();
          }
          return (async function* (): AsyncIterable<StreamChunk> {
            yield { type: "run-start", runId: "r", adapterId: "a", model: "m", ts: 1 };
            yield { type: "text-delta", runId: "r", text: "I changed the file." };
            yield { type: "tool-call-start", runId: "r", id: "write-1", name: "fs_write" };
            yield { type: "tool-call-end", runId: "r", id: "write-1", input: { path: "a.ts" } };
            yield {
              type: "tool-result",
              runId: "r",
              toolCallId: "write-1",
              content: [{ type: "text", text: "done" }],
            };
            const error = new AdapterError("transport", "lost connection", { retryable: true });
            yield { type: "error", runId: "r", error, retryable: true };
          })();
        },
        rootScope(),
        {
          partialRecovery: {
            enabled: true,
            originalGoal: "edit a.ts",
            classifyAction: () => "mutating",
            onPlan: (plan) => decisions.push(plan.decision),
          },
        },
      ),
    );

    expect(decisions).toEqual(["approval_required"]);
    expect(backupInvoked).toBe(false);
    expect(chunks.at(-1)?.type).toBe("error");
  });
});
