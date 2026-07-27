/**
 * Coordinator narration must reach `ctx.store` — not just the live bus.
 *
 * `oodaLoop` (runner.ts) yields two kinds of chunk on `Agent.run()`'s one
 * lane: its own `agentMetaChunk()` narration (step-start/plan/reflect/
 * progress/replan/retry/goal/stop, tagged `raw.agent`) and a raw pass-through
 * re-yield of each inner per-step `dispatchAgent` call's chunks. The inner
 * call persists ITS OWN chunks itself (through the same `ctx.store`, under
 * its own run id) — before this fix, nothing persisted the coordinator's own
 * narration, so a stored session could stream the OODA loop live but never
 * replay it: the whole step-start/plan/reflect/progress/replan/retry/stop
 * narrative (and the final `stop` event's `{stopReason, verdict}`) existed
 * only while the run was in flight.
 */
import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  type EventStore,
  type RunResult,
} from "@nexuscode/core";
import type { StreamChunk } from "@nexuscode/shared";
import { PermissionGate, ToolRegistry, okText, type Tool } from "@nexuscode/tools";
import { openTasks } from "@nexuscode/tasks";
import { createMockAdapter } from "@nexuscode/provider-mock";
import {
  Agent,
  createAgentRegistry,
  isAgentMeta,
  type AgentDefinition,
  type AgentDeps,
} from "../src/index.js";

function echoTool(name = "echo"): Tool {
  return {
    name,
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
}

interface StoredEntry {
  sessionId: string;
  turnId: string;
  runId: string;
  seq: number;
  chunk: StreamChunk;
}

/** An in-memory `EventStore` — the same seam `history.ts`/`SessionStore` implement. */
class FakeEventStore implements EventStore {
  readonly entries: StoredEntry[] = [];
  append(entry: StoredEntry): void {
    this.entries.push(entry);
  }
  summarize(_result: RunResult & { sessionId: string; turnId: string }): void {
    /* not under test here */
  }
}

describe("Agent.run() — coordinator narration reaches ctx.store", () => {
  it("persists every agent-meta phase chunk, in order, without duplicating the inner dispatch's own rows", async () => {
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ toolName: "echo", toolInput: (p) => ({ text: p }) }));
    const fakeStore = new FakeEventStore();
    const engine = createEngine({ registry, store: fakeStore });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "PING" });
    const ctx = turn.context();

    const tools = new ToolRegistry();
    tools.register(echoTool());
    const taskStore = openTasks({ file: ":memory:" });
    const deps: AgentDeps = {
      tools,
      gate: new PermissionGate({ mode: "full-access" }),
      store: taskStore,
      defaultModel: "mock-tools",
      defaultAdapterId: "mock",
      registry: createAgentRegistry(),
    };
    const def: AgentDefinition = {
      role: "coder",
      systemPrompt: "You are a test agent.",
      allowedTools: ["echo"],
      maxSteps: 6,
      permissionMode: "full-access",
    };
    const agent = new Agent(deps);

    const handle = agent.run(ctx, def, {
      goal: { objective: "read the config", successCriteria: ["config"] },
    });

    const liveChunks: StreamChunk[] = [];
    for await (const l of handle.events()) liveChunks.push(l.chunk);
    const result = await handle.result();
    expect(result.stopReason).toBe("goal-met");

    // Every agent-meta chunk seen live was persisted, same phases, same order.
    const isAgentMetaChunk = (c: StreamChunk): boolean =>
      c.type === "text-delta" && c.channel === "reasoning" && isAgentMeta(c.raw);
    const livePhases = liveChunks
      .filter(isAgentMetaChunk)
      .map((c) => (c as { raw: { agent: { phase: string } } }).raw.agent.phase);
    const persistedAgentChunks = fakeStore.entries.map((e) => e.chunk).filter(isAgentMetaChunk);
    const persistedPhases = persistedAgentChunks.map(
      (c) => (c as { raw: { agent: { phase: string } } }).raw.agent.phase,
    );
    expect(persistedPhases.length).toBeGreaterThan(0);
    expect(persistedPhases).toEqual(livePhases);
    expect(livePhases).toEqual(
      expect.arrayContaining(["step-start", "plan", "reflect", "progress", "stop"]),
    );

    // The `stop` event's verdict — the single most valuable field — survived intact.
    const stopChunk = persistedAgentChunks.find(
      (c) => (c as { raw: { agent: { phase: string } } }).raw.agent.phase === "stop",
    ) as { raw: { agent: { data?: unknown } } } | undefined;
    expect(stopChunk?.raw.agent.data).toMatchObject({
      stopReason: "goal-met",
      verdict: "met",
    });

    // No duplication: the inner per-step dispatch already persists its OWN
    // chunks (through this same ctx.store) — the coordinator lane must not
    // persist them a second time under `agentRunId`.
    const countOf = (chunks: StreamChunk[], type: StreamChunk["type"]): number =>
      chunks.filter((c) => c.type === type).length;
    for (const type of ["tool-call-start", "tool-result", "usage", "run-end"] as const) {
      expect(countOf(fakeStore.entries.map((e) => e.chunk), type)).toBe(
        countOf(liveChunks, type),
      );
    }

    await engine.dispose();
  });

  it("degrades cleanly with no ctx.store (bus streaming still works)", async () => {
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ toolName: "echo", toolInput: (p) => ({ text: p }) }));
    // No `store` passed to createEngine — ctx.store stays undefined.
    const engine = createEngine({ registry });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "PING" });
    const ctx = turn.context();

    const tools = new ToolRegistry();
    tools.register(echoTool());
    const taskStore = openTasks({ file: ":memory:" });
    const deps: AgentDeps = {
      tools,
      gate: new PermissionGate({ mode: "full-access" }),
      store: taskStore,
      defaultModel: "mock-tools",
      defaultAdapterId: "mock",
      registry: createAgentRegistry(),
    };
    const def: AgentDefinition = {
      role: "coder",
      systemPrompt: "You are a test agent.",
      allowedTools: ["echo"],
      maxSteps: 6,
      permissionMode: "full-access",
    };
    const agent = new Agent(deps);
    const handle = agent.run(ctx, def, {
      goal: { objective: "read the config", successCriteria: ["config"] },
    });

    const liveChunks: StreamChunk[] = [];
    for await (const l of handle.events()) liveChunks.push(l.chunk);
    const result = await handle.result();
    expect(result.stopReason).toBe("goal-met");
    expect(liveChunks.length).toBeGreaterThan(0);

    await engine.dispose();
  });
});
