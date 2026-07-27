/**
 * Tests for `delegatingEvaluate` (policies.ts) — the opt-in Evaluate/Reflect
 * policy that hands a step to `coordinator` when the failure is a structural
 * "no such tool" capability gap, instead of retrying an error a retry can
 * never fix. See the policy's own doc comment for the full rationale.
 *
 * Two layers:
 *  - Pure unit tests directly against a hand-built `EvaluateInput`, mirroring
 *    `defaultEvaluate`'s own shape, with no engine/provider involved.
 *  - End-to-end tests through the real `Agent` OODA loop with the offline
 *    mock provider (same harness style as `agent.test.ts`), proving the
 *    directive actually resolves the objective, respects the permission
 *    ceiling, and cannot recurse without bound.
 */
import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  type Engine,
  type Labeled,
  type OrchestrationOutcome,
  type RunContext,
  type RunResult,
} from "@nexuscode/core";
import type { StreamChunk } from "@nexuscode/shared";
import { PermissionGate, ToolRegistry, okText, type Tool } from "@nexuscode/tools";
import { openTasks, type TaskStore } from "@nexuscode/tasks";
import { createMockAdapter } from "@nexuscode/provider-mock";
import {
  Agent,
  createAgentRegistry,
  defaultEvaluate,
  delegatingEvaluate,
  isAgentMeta,
  type AgentDefinition,
  type AgentDeps,
  type AgentPhase,
  type EvaluateInput,
} from "../src/index.js";

// ── Fake EvaluateInput (pure unit tests, no engine) ───────────────────────────

function fakeOutcome(over: Partial<RunResult> = {}): OrchestrationOutcome {
  const winner: RunResult = {
    runId: "r1",
    adapterId: "mock",
    model: "mock-tools",
    status: "ok",
    text: "",
    toolCalls: [],
    diffs: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    ...over,
  };
  return { kind: "single", runs: [winner], winner, usage: winner.usage, partial: false };
}

function fakeInput(over: Partial<EvaluateInput> = {}): EvaluateInput {
  return {
    role: "coder",
    goal: { objective: "build the thing", successCriteria: ["done"] },
    step: 0,
    maxSteps: 5,
    retriesUsed: 0,
    maxRetries: 2,
    outcome: fakeOutcome(),
    stepText: "",
    toolResults: [],
    evidence: "",
    criterionTaskIds: ["c0"],
    rootTaskId: "root",
    cancelled: false,
    ...over,
  };
}

describe("delegatingEvaluate — unit (pure function of EvaluateInput)", () => {
  it("emits a DelegateDirective to coordinator when the failure is a structural 'no such tool' gap", () => {
    const input = fakeInput({
      toolResults: [{ id: "t1", isError: true, text: "no such tool: shell_exec" }],
    });
    const reflection = delegatingEvaluate(input);

    expect(reflection.delegate).toBeDefined();
    expect(reflection.delegate?.role).toBe("coordinator");
    expect(reflection.delegate?.goal.objective).toContain("shell_exec");
    expect(reflection.delegate?.goal.objective).toContain("coder");
    expect(reflection.delegate?.goal.successCriteria).toEqual(["done"]);

    // The retry budget isn't wasted on a gap a retry can't close.
    expect(reflection.retry).toBe(false);
    expect(reflection.needsReplan).toBe(false);
    expect(reflection.stop).toBeUndefined();

    // Honesty preserved: a failure is a failure, never laundered into "met".
    expect(reflection.failure).toBe(true);
    expect(reflection.goalMet).toBe(false);
    expect(reflection.verdict).toBe("unmet");
  });

  it("does NOT delegate on a clean, successful step (identical to defaultEvaluate)", () => {
    const input = fakeInput({ stepText: "done", evidence: "\ndone" });
    const reflection = delegatingEvaluate(input);
    expect(reflection.delegate).toBeUndefined();
    expect(reflection).toEqual(defaultEvaluate(input));
    expect(reflection.goalMet).toBe(true);
  });

  it("does NOT delegate on a transient tool failure that is not a capability gap", () => {
    const input = fakeInput({
      toolResults: [{ id: "t1", isError: true, text: "disk offline" }],
    });
    const reflection = delegatingEvaluate(input);
    expect(reflection.delegate).toBeUndefined();
    expect(reflection).toEqual(defaultEvaluate(input));
    // A transient failure still gets the normal retry treatment.
    expect(reflection.retry).toBe(true);
  });

  it("does NOT delegate when the step was cancelled", () => {
    const input = fakeInput({
      cancelled: true,
      toolResults: [{ id: "t1", isError: true, text: "no such tool: shell_exec" }],
    });
    const reflection = delegatingEvaluate(input);
    expect(reflection.delegate).toBeUndefined();
    expect(reflection).toEqual(defaultEvaluate(input));
    expect(reflection.stop).toBe("cancelled");
  });

  it("does NOT self-delegate when already running as coordinator", () => {
    const input = fakeInput({
      role: "coordinator",
      toolResults: [{ id: "t1", isError: true, text: "no such tool: nope" }],
    });
    const reflection = delegatingEvaluate(input);
    expect(reflection.delegate).toBeUndefined();
    expect(reflection).toEqual(defaultEvaluate(input));
  });
});

// ── End-to-end harness (mirrors agent.test.ts) ────────────────────────────────

interface Harness {
  engine: Engine;
  ctx: RunContext;
  store: TaskStore;
}

async function harness(opts: { toolName: string }): Promise<Harness> {
  const registry = new ProviderRegistry();
  await registry.register(createMockAdapter({ toolName: opts.toolName, toolInput: (p) => ({ text: p }) }));
  const engine = createEngine({ registry });
  const session = await engine.openSession();
  const turn = session.newTurn({ prompt: "PING" });
  const ctx = turn.context();
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

function phasesIn(events: Labeled<StreamChunk>[]): AgentPhase[] {
  const phases: AgentPhase[] = [];
  for (const e of events) {
    const c = e.chunk;
    if (c.type === "text-delta" && c.channel === "reasoning" && isAgentMeta(c.raw)) phases.push(c.raw.agent.phase);
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

/** A tool that always succeeds with a fixed text, of a chosen permission class. */
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

describe("delegatingEvaluate — end-to-end via the real OODA loop", () => {
  it("delegates to coordinator when the objective needs a tool outside the role's allowlist, and the sub-agent finishes it", async () => {
    const { engine, ctx, store } = await harness({ toolName: "shell_exec" });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    tools.register(fixedTool("shell_exec", "write", "shell output: OK"));
    const agent = new Agent(deps(store, tools));

    const handle = agent.run(
      ctx,
      customDef({ role: "coder", allowedTools: ["echo"], permissionMode: "full-access", maxSteps: 1 }),
      {
        goal: { objective: "run the build script", successCriteria: ["OK"] },
        policies: { evaluate: delegatingEvaluate },
      },
    );

    const events = await drain(handle.events());
    const result = await handle.result();

    // "coder" never had shell_exec (outside its allowlist) — a retry could
    // never grant it, so the step was delegated instead.
    expect(phasesIn(events)).toContain("delegate");
    expect(result.subAgents).toHaveLength(1);
    expect(result.subAgents[0]?.role).toBe("coordinator");

    // coordinator (allowedTools: ["*"]) actually had the tool and finished
    // the delegated objective.
    expect(result.subAgents[0]?.stopReason).toBe("goal-met");
    expect(result.subAgents[0]?.finalText).toContain("OK");
    expect(result.stopReason).toBe("max-steps");

    await engine.dispose();
  });

  it("never lets a delegated child exceed the parent's permission ceiling", async () => {
    const { engine, ctx, store } = await harness({ toolName: "write_file" });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    // Registered globally, but NOT in the parent's allowlist, and it is a
    // write-class tool — so it probes both halves of the ceiling.
    tools.register(fixedTool("write_file", "write", "written"));
    const agent = new Agent(deps(store, tools));

    // A read-only role: it structurally cannot call write_file at all (not in
    // its allowlist), AND even if it could see it, its sandbox denies writes.
    const handle = agent.run(
      ctx,
      customDef({ role: "reader", allowedTools: ["echo"], permissionMode: "read-only", maxSteps: 1 }),
      {
        goal: { objective: "persist the result", successCriteria: ["written"] },
        policies: { evaluate: delegatingEvaluate },
      },
    );

    await drain(handle.events());
    const result = await handle.result();

    expect(result.subAgents).toHaveLength(1);
    const sub = result.subAgents[0]!;
    // coordinator nominally has allowedTools: ["*"] AND a workspace-write
    // preset — but it must inherit the read-only ceiling from its delegator,
    // so it can never actually complete the write.
    expect(sub.role).toBe("coordinator");
    expect(sub.stopReason).not.toBe("goal-met");
    expect(sub.stopReason).toBe("blocked");

    // The tool WAS visible to coordinator (no "no such tool" — the allowlist
    // gap is what delegation fixes) but every attempt was denied by the gate
    // at the parent's read-only ceiling, not coordinator's own workspace-write.
    const toolErrors = sub.steps.flatMap((s) => s.toolResults.filter((t) => t.isError).map((t) => t.text));
    expect(toolErrors.length).toBeGreaterThan(0);
    for (const text of toolErrors) {
      expect(text).not.toContain("no such tool");
      expect(text).toContain("permission denied");
      expect(text).toContain("read-only");
    }

    await engine.dispose();
  });

  it("terminates: delegation cannot recurse past one hop, even when the trigger keeps firing", async () => {
    const { engine, ctx, store } = await harness({ toolName: "ghost_tool" });
    const tools = new ToolRegistry();
    // "ghost_tool" is never registered anywhere — not even coordinator's
    // full ["*"] grant can reach it, so the gap can never close.
    tools.register(echoTool());
    const agent = new Agent(deps(store, tools));

    const handle = agent.run(
      ctx,
      customDef({ role: "coder", allowedTools: ["echo"], permissionMode: "full-access", maxSteps: 3 }),
      {
        goal: { objective: "do the impossible", successCriteria: ["never"] },
        policies: { evaluate: delegatingEvaluate },
      },
    );

    await drain(handle.events());
    const result = await handle.result();

    // Bounded by the parent's own step budget — one delegation per parent step.
    expect(result.stopReason).toBe("max-steps");
    expect(result.subAgents).toHaveLength(3);

    for (const sub of result.subAgents) {
      expect(sub.role).toBe("coordinator");
      // The runner does not forward a run's policies to a delegated child, so
      // every child runs under defaultEvaluate — which never delegates. Depth
      // is capped at exactly one hop by construction, not by a counter.
      expect(sub.subAgents).toHaveLength(0);
      // Bounded by its own retry budget (default 2): 1 initial attempt + 2
      // retries, then it blocks — it never reaches goal-met.
      expect(sub.stopReason).toBe("blocked");
      expect(sub.steps).toHaveLength(3);
    }

    // A concrete, finite bound on total work: 3 parent steps + 3 children ×
    // 3 steps each — never unbounded.
    const totalChildSteps = result.subAgents.reduce((n, sa) => n + sa.steps.length, 0);
    expect(totalChildSteps).toBe(9);
    expect(result.steps).toHaveLength(3);

    await engine.dispose();
  });

  it("opt-in guard: the identical capability-gap scenario does NOT delegate under defaultEvaluate", async () => {
    const { engine, ctx, store } = await harness({ toolName: "shell_exec" });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    tools.register(fixedTool("shell_exec", "write", "shell output: OK"));
    const agent = new Agent(deps(store, tools));

    // Same exact setup as the first end-to-end test, but WITHOUT selecting
    // delegatingEvaluate — the run must use the framework's unmodified
    // default policy and never delegate.
    const handle = agent.run(
      ctx,
      customDef({ role: "coder", allowedTools: ["echo"], permissionMode: "full-access", maxSteps: 5 }),
      { goal: { objective: "run the build script", successCriteria: ["OK"] } },
    );

    const events = await drain(handle.events());
    const result = await handle.result();

    expect(phasesIn(events)).not.toContain("delegate");
    expect(result.subAgents).toHaveLength(0);
    // defaultEvaluate's ordinary retry-then-block path: 1 initial + 2 retries.
    expect(result.stopReason).toBe("blocked");
    expect(result.steps).toHaveLength(3);

    await engine.dispose();
  });
});
