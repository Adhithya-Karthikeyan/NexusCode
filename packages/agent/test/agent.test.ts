import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  type Engine,
  type Labeled,
  type RunContext,
} from "@nexuscode/core";
import type { StreamChunk } from "@nexuscode/shared";
import { PermissionGate, ToolRegistry, okText, errText, type Tool } from "@nexuscode/tools";
import { openTasks, type TaskStore } from "@nexuscode/tasks";
import { createMockAdapter } from "@nexuscode/provider-mock";
import {
  Agent,
  createAgentRegistry,
  isAgentMeta,
  type AgentDefinition,
  type AgentDeps,
  type AgentPhase,
  type EvaluateFn,
} from "../src/index.js";

// ── Tools (offline, deterministic) ────────────────────────────────────────────

/** A read-class tool that echoes `{ text }` back. */
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

/** A tool that returns a fixed text (used to inject success-criterion keywords). */
function fixedTool(name: string, permission: Tool["permission"], text: string): Tool {
  return {
    name,
    description: `Return "${text}".`,
    permission,
    parameters: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
    async run() {
      return okText(text);
    },
  };
}

/** A write-class tool that FAILS its first call, then succeeds (self-correction). */
function flakyTool(name: string): Tool {
  let calls = 0;
  return {
    name,
    description: "Fails once, then succeeds.",
    permission: "write",
    parameters: { type: "object", properties: { text: { type: "string" } }, additionalProperties: true },
    async run() {
      calls += 1;
      if (calls === 1) return errText("disk offline");
      return okText("wrote file");
    },
  };
}

// ── Harness ───────────────────────────────────────────────────────────────────

interface Harness {
  engine: Engine;
  ctx: RunContext;
  store: TaskStore;
}

async function harness(opts: {
  toolName: string;
  cancel?: boolean;
  /** Script the non-tool models' answers (used to script the evaluation turn). */
  transform?: (prompt: string, model: string) => string;
}): Promise<Harness> {
  const registry = new ProviderRegistry();
  await registry.register(
    createMockAdapter({
      toolName: opts.toolName,
      toolInput: (p) => ({ text: p }),
      ...(opts.transform ? { transform: opts.transform } : {}),
    }),
  );
  const engine = createEngine({ registry });
  const session = await engine.openSession();
  const turn = session.newTurn({ prompt: "PING" });
  const ctx = turn.context();
  if (opts.cancel) await ctx.scope.cancel("user");
  const store = openTasks({ file: ":memory:" });
  return { engine, ctx, store };
}

function deps(store: TaskStore, tools: ToolRegistry, extra?: Partial<AgentDeps>): AgentDeps {
  return {
    tools,
    gate: new PermissionGate({ mode: "full-access" }),
    store,
    defaultModel: "mock-tools",
    defaultAdapterId: "mock",
    registry: createAgentRegistry(),
    ...extra,
  };
}

async function drain(events: AsyncIterable<Labeled<StreamChunk>>): Promise<Labeled<StreamChunk>[]> {
  const out: Labeled<StreamChunk>[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** All agent-meta phases present in a labeled chunk stream. */
function phasesIn(events: Labeled<StreamChunk>[]): AgentPhase[] {
  const phases: AgentPhase[] = [];
  for (const e of events) {
    const c = e.chunk;
    if (c.type === "text-delta" && c.channel === "reasoning" && isAgentMeta(c.raw)) {
      phases.push(c.raw.agent.phase);
    }
  }
  return phases;
}

function customDef(over: Partial<AgentDefinition> & { role: string }): AgentDefinition {
  return {
    systemPrompt: "You are a test agent.",
    allowedTools: ["echo"],
    maxSteps: 6,
    permissionMode: "full-access",
    ...over,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("Agent — OODA loop over the native tool loop", () => {
  it("goal-driven run: drafts a plan, acts via a tool, evaluates, and finishes", async () => {
    const { engine, ctx, store } = await harness({ toolName: "echo" });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    const agent = new Agent(deps(store, tools));

    const handle = agent.run(ctx, customDef({ role: "coder", allowedTools: ["echo"] }), {
      goal: { objective: "read the config", successCriteria: ["config"] },
    });

    const events = await drain(handle.events());
    const result = await handle.result();
    const chunks = events.map((e) => e.chunk);

    // Finished by meeting the goal in a single step.
    expect(result.stopReason).toBe("goal-met");
    expect(result.goalMet).toBe(true);
    expect(result.steps).toHaveLength(1);

    // It ACTED: a real native tool call flowed through the bus...
    expect(chunks.some((c) => c.type === "tool-call-end")).toBe(true);
    expect(result.steps[0]?.toolCalls.map((t) => t.name)).toEqual(["echo"]);
    // ...and the loop closed to a final answer referencing the tool result.
    expect(result.finalText).toContain("echoed: read the config");

    // It PLANNED: a root task + one criterion task, both driven to done → 100%.
    expect(result.plan.length).toBe(2);
    expect(result.progress.percent).toBe(100);
    expect(result.plan.every((t) => t.status === "done")).toBe(true);

    // Progress rode the bus as agent-meta StreamChunks (not a side channel).
    const phases = phasesIn(events);
    expect(phases).toContain("plan");
    expect(phases).toContain("reflect");
    expect(phases).toContain("progress");
    expect(phases).toContain("stop");

    await engine.dispose();
  });

  it("reflects, replans, and self-corrects on a simulated tool failure", async () => {
    const { engine, ctx, store } = await harness({ toolName: "recover_fs" });
    const tools = new ToolRegistry();
    tools.register(flakyTool("recover_fs"));
    const agent = new Agent(deps(store, tools));

    const handle = agent.run(
      ctx,
      customDef({ role: "coder", allowedTools: ["recover_fs"], permissionMode: "full-access" }),
      { goal: { objective: "persist the result", successCriteria: ["wrote file"] }, maxSteps: 4 },
    );

    const events = await drain(handle.events());
    const result = await handle.result();

    // Two steps: the first failed, the second recovered.
    expect(result.steps).toHaveLength(2);
    const first = result.steps[0]!;
    expect(first.toolResults[0]?.isError).toBe(true);
    expect(first.reflection.failure).toBe(true);
    expect(first.reflection.needsReplan).toBe(true);
    expect(first.reflection.retry).toBe(true);

    // Dynamic replanning surfaced on the bus, and a recovery task was added.
    expect(phasesIn(events)).toContain("replan");
    expect(result.plan.some((t) => t.title.startsWith("Recover from failure"))).toBe(true);

    // The self-correction worked: the goal was ultimately met.
    expect(result.stopReason).toBe("goal-met");
    expect(result.finalText).toContain("wrote file");

    await engine.dispose();
  });

  it("runs a specialized agent (reviewer) with its role prompt + tool allowlist", async () => {
    const { engine, ctx, store } = await harness({ toolName: "fs_read" });
    // Global tool set is broader than the reviewer's allowlist.
    const tools = new ToolRegistry();
    tools.register(fixedTool("fs_read", "read", "file contents: OK"));
    tools.register(fixedTool("fs_search", "read", "no matches"));
    tools.register(fixedTool("fs_write", "write", "written"));
    const agent = new Agent(deps(store, tools));

    const handle = agent.runRole(ctx, "reviewer", {
      goal: { objective: "review the change", successCriteria: ["OK"] },
    });

    await drain(handle.events());
    const result = await handle.result();

    // The reviewer's assembled role prompt was used (via @nexuscode/prompt).
    expect(result.role).toBe("reviewer");
    expect(result.systemPrompt).toContain("reviewer");
    expect(result.systemPrompt).toContain("Read-only");

    // The allowlist was enforced: the write tool was NOT available to the run.
    expect(result.steps[0]?.toolsAvailable).toEqual(["fs_read", "fs_search"]);
    expect(result.steps[0]?.toolsAvailable).not.toContain("fs_write");

    // It still met its goal by reading.
    expect(result.stopReason).toBe("goal-met");
    expect(result.steps[0]?.toolCalls.map((t) => t.name)).toEqual(["fs_read"]);

    await engine.dispose();
  });

  it("delegates a subtask to a specialized sub-agent with isolated context", async () => {
    const { engine, ctx, store } = await harness({ toolName: "echo" });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    const agent = new Agent(deps(store, tools));

    // A sub-agent definition sandboxed to just the echo tool.
    const subReviewer = customDef({
      role: "reviewer",
      systemPrompt: "You are the reviewer sub-agent.",
      allowedTools: ["echo"],
      permissionMode: "read-only",
      maxSteps: 2,
    });

    // Coordinator policy: delegate on step 0, then declare the goal met on step 1.
    const evaluate: EvaluateFn = ({ step }) => {
      if (step === 0) {
        return {
          critique: "Delegating the review before finishing.",
          progress: 0,
          goalMet: false,
          failure: false,
          needsReplan: false,
          retry: false,
          delegate: { role: subReviewer, goal: { objective: "review it", successCriteria: ["echoed"] } },
        };
      }
      return {
        critique: "Sub-agent finished; goal met.",
        progress: 100,
        goalMet: true,
        failure: false,
        needsReplan: false,
        retry: false,
      };
    };

    const handle = agent.run(ctx, customDef({ role: "coordinator", allowedTools: ["*"] }), {
      goal: { objective: "coordinate a review", successCriteria: [] },
      policies: { evaluate },
    });

    const events = await drain(handle.events());
    const result = await handle.result();

    // A sub-agent actually ran, in the reviewer role, and returned its result.
    expect(result.subAgents).toHaveLength(1);
    expect(result.subAgents[0]?.role).toBe("reviewer");
    expect(result.subAgents[0]?.finalText).toContain("echoed");

    // Isolated context: the sub-agent had only its own tool allowlist.
    expect(result.subAgents[0]?.steps[0]?.toolsAvailable).toEqual(["echo"]);

    // The delegation, and the sub-agent's own chunks, flowed through the parent bus.
    expect(phasesIn(events)).toContain("delegate");
    const sawReviewerChunk = events.some(
      (e) =>
        e.chunk.type === "text-delta" &&
        e.chunk.channel === "reasoning" &&
        isAgentMeta(e.chunk.raw) &&
        e.chunk.raw.agent.role === "reviewer",
    );
    expect(sawReviewerChunk).toBe(true);

    expect(result.stopReason).toBe("goal-met");

    await engine.dispose();
  });

  it("honors the max-steps cap when the goal is never met", async () => {
    const { engine, ctx, store } = await harness({ toolName: "echo" });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    const agent = new Agent(deps(store, tools));

    const handle = agent.run(ctx, customDef({ role: "coder", allowedTools: ["echo"] }), {
      goal: { objective: "do the impossible", successCriteria: ["UNREACHABLE_ZZZ"] },
      maxSteps: 2,
    });

    await drain(handle.events());
    const result = await handle.result();

    expect(result.stopReason).toBe("max-steps");
    expect(result.goalMet).toBe(false);
    expect(result.steps).toHaveLength(2);
    expect(result.progress.percent).toBeLessThan(100);

    await engine.dispose();
  });

  it("honors cancellation: a pre-cancelled scope stops the loop immediately", async () => {
    const { engine, ctx, store } = await harness({ toolName: "echo", cancel: true });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    const agent = new Agent(deps(store, tools));

    const handle = agent.run(ctx, customDef({ role: "coder", allowedTools: ["echo"] }), {
      goal: { objective: "anything", successCriteria: ["x"] },
    });

    const events = await drain(handle.events());
    const result = await handle.result();

    expect(result.stopReason).toBe("cancelled");
    expect(result.goalMet).toBe(false);
    expect(result.steps).toHaveLength(0);
    // Even a cancelled run terminates cleanly with a stop meta-chunk.
    expect(phasesIn(events)).toContain("stop");

    await engine.dispose();
  });
});
