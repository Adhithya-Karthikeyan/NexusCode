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
import type { FinishReason, StreamChunk } from "@nexuscode/shared";
import { PermissionGate, ToolRegistry, okText, errText, type Tool } from "@nexuscode/tools";
import { openTasks, type TaskStore } from "@nexuscode/tasks";
import { createMockAdapter } from "@nexuscode/provider-mock";
import {
  Agent,
  createAgentRegistry,
  defaultEvaluate,
  defaultVerify,
  isAgentMeta,
  parseVerdict,
  VERDICT_TOKEN,
  type AgentDefinition,
  type AgentDeps,
  type AgentPhase,
  type EvaluateFn,
  type EvaluateInput,
  type Reflection,
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

// ── Honest goal detection ─────────────────────────────────────────────────────

/** The evaluation turn is the one whose prompt carries the verdict contract. */
function isEvaluationPrompt(prompt: string): boolean {
  return prompt.includes(VERDICT_TOKEN) && prompt.includes("EVIDENCE:");
}

describe("Agent — a run may only claim success it can actually evidence", () => {
  it("does NOT report goalMet/100% just because the model emitted text on a clean step", async () => {
    // The regression: with no success criteria, ANY non-empty answer on a clean
    // step was reported as "Goal satisfied · 100% · goalMet=true" — so an
    // impossible objective the model merely restated came back as a success.
    const { engine, ctx, store } = await harness({ toolName: "echo" });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    const agent = new Agent(deps(store, tools));

    const handle = agent.run(ctx, customDef({ role: "coder", allowedTools: ["echo"] }), {
      // No successCriteria — exactly what the CLI and SDK pass today.
      goal: { objective: "rewrite the entire kernel in rust and prove it memory-safe" },
      model: "mock-fast",
      maxSteps: 4,
    });

    const events = await drain(handle.events());
    const result = await handle.result();

    // The model DID answer (the old "evidence" of success)...
    expect(result.finalText.trim().length).toBeGreaterThan(0);
    expect(result.steps[0]?.status).toBe("ok");
    // ...and the run still refuses to call that a met goal.
    expect(result.goalMet).toBe(false);
    expect(result.verdict).toBe("indeterminate");
    expect(result.stopReason).toBe("indeterminate");
    expect(result.progress.percent).toBeLessThan(100);
    expect(result.steps[0]?.reflection.goalMet).toBe(false);

    // And it SAYS so, rather than going quiet about the uncertainty.
    const narration = events
      .map((e) => (e.chunk.type === "text-delta" && e.chunk.channel === "reasoning" ? e.chunk.text : ""))
      .join("\n");
    expect(narration).toMatch(/UNVERIFIED/);
    expect(narration).not.toMatch(/Goal satisfied/);

    await engine.dispose();
  });

  it("promotes to goal-met when the explicit evaluation turn returns a MET verdict", async () => {
    const { engine, ctx, store } = await harness({
      toolName: "echo",
      // A scripted evaluator: the work turn answers normally, the evaluation
      // turn returns the one-line verdict the contract asks for.
      transform: (prompt) =>
        isEvaluationPrompt(prompt)
          ? `${VERDICT_TOKEN} MET - the evidence shows the requested summary was produced`
          : "Wrote the summary as requested.",
    });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    const agent = new Agent(deps(store, tools));

    const handle = agent.run(ctx, customDef({ role: "coder", allowedTools: ["echo"] }), {
      goal: { objective: "summarize the config" },
      model: "mock-fast",
      maxSteps: 4,
    });

    await drain(handle.events());
    const result = await handle.result();

    expect(result.verdict).toBe("met");
    expect(result.goalMet).toBe(true);
    expect(result.stopReason).toBe("goal-met");
    expect(result.progress.percent).toBe(100);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.reflection.critique).toContain("verified");
    // The evaluation turn's tokens are accounted to the run, not hidden.
    expect(result.usage.inputTokens).toBeGreaterThan(0);

    await engine.dispose();
  });

  it("keeps working — and never claims success — while the evaluation returns NOT_MET", async () => {
    const { engine, ctx, store } = await harness({
      toolName: "echo",
      transform: (prompt) =>
        isEvaluationPrompt(prompt)
          ? `${VERDICT_TOKEN} NOT_MET - nothing was written, the answer only describes the plan`
          : "Here is how I would do it.",
    });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    const agent = new Agent(deps(store, tools));

    const handle = agent.run(ctx, customDef({ role: "coder", allowedTools: ["echo"] }), {
      goal: { objective: "write the migration" },
      model: "mock-fast",
      maxSteps: 3,
    });

    await drain(handle.events());
    const result = await handle.result();

    // A determinate negative: the budget ran out with the goal known-unmet.
    expect(result.stopReason).toBe("max-steps");
    expect(result.verdict).toBe("unmet");
    expect(result.goalMet).toBe(false);
    expect(result.steps).toHaveLength(3);
    expect(result.progress.percent).toBeLessThan(100);
    // The evaluator's reason is fed back as corrective context, not swallowed.
    expect(result.steps[0]?.reflection.correction).toContain("nothing was written");

    await engine.dispose();
  });

  it("treats an unusable evaluation answer as unknown — never as a pass", async () => {
    // A model that ignores the contract and echoes its instructions back names
    // BOTH verdicts; that must resolve to "unknown", not the more flattering one.
    const { engine, ctx, store } = await harness({
      toolName: "echo",
      transform: (prompt) => (isEvaluationPrompt(prompt) ? prompt : "done"),
    });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    const agent = new Agent(deps(store, tools));

    const handle = agent.run(ctx, customDef({ role: "coder", allowedTools: ["echo"] }), {
      goal: { objective: "do the thing" },
      model: "mock-fast",
      maxSteps: 4,
    });

    await drain(handle.events());
    const result = await handle.result();

    expect(result.verdict).toBe("indeterminate");
    expect(result.goalMet).toBe(false);
    expect(result.stopReason).toBe("indeterminate");

    await engine.dispose();
  });

  it("reports an unverified outcome when verification is disabled entirely", async () => {
    const { engine, ctx, store } = await harness({ toolName: "echo" });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    const agent = new Agent(deps(store, tools, { verify: false }));

    const handle = agent.run(ctx, customDef({ role: "coder", allowedTools: ["echo"] }), {
      goal: { objective: "anything at all" },
      model: "mock-fast",
      maxSteps: 4,
    });

    await drain(handle.events());
    const result = await handle.result();

    expect(result.verdict).toBe("indeterminate");
    expect(result.goalMet).toBe(false);
    expect(result.stopReason).toBe("indeterminate");
    expect(result.steps).toHaveLength(1);

    await engine.dispose();
  });

  it("declared success criteria still settle the goal deterministically (no evaluation turn)", async () => {
    // With criteria, the caller's contract is the signal — the model is never
    // asked to grade its own work, so a scripted MET verdict cannot rescue it.
    const { engine, ctx, store } = await harness({
      toolName: "echo",
      transform: () => `${VERDICT_TOKEN} MET - trust me`,
    });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    const agent = new Agent(deps(store, tools));

    const handle = agent.run(ctx, customDef({ role: "coder", allowedTools: ["echo"] }), {
      goal: { objective: "do the impossible", successCriteria: ["UNREACHABLE_ZZZ"] },
      model: "mock-fast",
      maxSteps: 2,
    });

    await drain(handle.events());
    const result = await handle.result();

    expect(result.stopReason).toBe("max-steps");
    expect(result.verdict).toBe("unmet");
    expect(result.goalMet).toBe(false);

    await engine.dispose();
  });
});

describe("Agent — a step that runs out of budget is not a step that succeeded", () => {
  it("surfaces turn-budget exhaustion as a failed step, even though the kernel calls it ok", async () => {
    // `mock-tools` always asks for a tool, so a one-turn budget is spent before
    // it can answer. The kernel synthesizes finishReason "length" with
    // status "ok" (transport-level success) — the agent must not read that as a
    // completed step.
    const { engine, ctx, store } = await harness({ toolName: "echo" });
    const tools = new ToolRegistry();
    tools.register(echoTool());
    const agent = new Agent(deps(store, tools, { maxTurnsPerStep: 1 }));

    const handle = agent.run(ctx, customDef({ role: "coder", allowedTools: ["echo"] }), {
      goal: { objective: "read the config", successCriteria: ["config"] },
      maxSteps: 3,
      maxRetries: 0,
    });

    await drain(handle.events());
    const result = await handle.result();

    const first = result.steps[0]!;
    // The kernel's own view of the step: "ok", but truncated by the budget.
    expect(first.status).toBe("ok");
    // The agent's view: not a success.
    expect(first.reflection.failure).toBe(true);
    expect(first.reflection.goalMet).toBe(false);
    expect(first.reflection.verdict).toBe("unmet");
    expect(first.reflection.critique).toContain("budget");

    // With no retry budget left, that is a blocked run — not an "ok" one.
    expect(result.stopReason).toBe("blocked");
    expect(result.goalMet).toBe(false);
    expect(result.progress.percent).toBeLessThan(100);

    await engine.dispose();
  });
});

describe("defaultEvaluate — the two paths that used to manufacture a success", () => {
  /** A clean, successful single-lane outcome, optionally truncated by a budget. */
  function outcomeOf(text: string, finishReason: FinishReason = "stop"): OrchestrationOutcome {
    const run: RunResult = {
      runId: "run_1",
      adapterId: "mock",
      model: "mock-fast",
      status: "ok",
      finishReason,
      text,
      toolCalls: [],
      diffs: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    return { kind: "single", runs: [run], winner: run, usage: run.usage, partial: false };
  }

  function evaluateStep(over: Partial<EvaluateInput> = {}): Reflection {
    return defaultEvaluate({
      role: "coder",
      goal: { objective: "do the work" },
      step: 0,
      maxSteps: 4,
      retriesUsed: 0,
      maxRetries: 2,
      outcome: outcomeOf("some answer"),
      stepText: "some answer",
      toolResults: [],
      evidence: "some answer",
      criterionTaskIds: [],
      rootTaskId: "root",
      cancelled: false,
      ...over,
    });
  }

  it("non-empty text on a clean step is not a met goal when nothing declares what success is", () => {
    const r = evaluateStep();
    expect(r.goalMet).toBe(false);
    expect(r.verdict).toBe("indeterminate");
    expect(r.progress).toBe(0);
  });

  it("a step truncated by its turn/output budget is a failure, not a clean step", () => {
    const r = evaluateStep({
      goal: { objective: "do the work", successCriteria: ["some answer"] },
      outcome: outcomeOf("[agent] max turns reached", "length"),
      evidence: "some answer",
    });
    // The criterion text IS present in the evidence, and the kernel called the
    // run "ok" — the goal must still not be reported as met off a truncated step.
    expect(r.goalMet).toBe(false);
    expect(r.verdict).toBe("unmet");
    expect(r.failure).toBe(true);
    expect(r.critique).toContain("budget");
  });
});

describe("parseVerdict — the verdict contract cannot be satisfied by accident", () => {
  it("accepts exactly one unambiguous verdict", () => {
    expect(parseVerdict(`${VERDICT_TOKEN} MET - the tests pass`)).toEqual({
      verdict: "met",
      reason: "the tests pass",
    });
    expect(parseVerdict(`thinking…\n${VERDICT_TOKEN} NOT_MET - the file is still empty`)).toEqual({
      verdict: "unmet",
      reason: "the file is still empty",
    });
  });

  it("returns unknown for an echo of the instructions, conflicts, or silence", () => {
    // The prompt names both verdicts, so echoing it is self-contradictory.
    const echoed = `${VERDICT_TOKEN} MET - <justification>\n${VERDICT_TOKEN} NOT_MET - <what is missing>`;
    expect(parseVerdict(echoed).verdict).toBe("indeterminate");
    expect(parseVerdict("Yes, that all looks done to me!").verdict).toBe("indeterminate");
    expect(parseVerdict("").verdict).toBe("indeterminate");
  });
});

describe("defaultVerify — every uncertain path resolves to unknown", () => {
  const goal = { objective: "ship it" };

  it("asks the model with the evidence and returns its verdict", async () => {
    let seen = "";
    const out = await defaultVerify({
      role: "coder",
      goal,
      step: 0,
      stepText: "shipped",
      toolResults: [],
      evidence: "built and deployed v2",
      ask: async (prompt) => {
        seen = prompt;
        return `${VERDICT_TOKEN} MET - v2 is deployed`;
      },
    });

    expect(out).toEqual({ verdict: "met", reason: "v2 is deployed" });
    expect(seen).toContain("built and deployed v2");
    expect(seen).toContain("ship it");
  });

  it("never asks — and never passes — when there is no evidence at all", async () => {
    let asked = false;
    const out = await defaultVerify({
      role: "coder",
      goal,
      step: 0,
      stepText: "",
      toolResults: [],
      evidence: "   \n  ",
      ask: async () => {
        asked = true;
        return `${VERDICT_TOKEN} MET - sure`;
      },
    });

    expect(asked).toBe(false);
    expect(out.verdict).toBe("indeterminate");
  });

  it("reports unknown when the evaluation turn itself does not complete", async () => {
    const out = await defaultVerify({
      role: "coder",
      goal,
      step: 0,
      stepText: "x",
      toolResults: [],
      evidence: "some work happened",
      ask: async () => undefined,
    });

    expect(out.verdict).toBe("indeterminate");
    expect(out.reason).toContain("did not complete");
  });
});
