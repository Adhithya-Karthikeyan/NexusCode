/**
 * The agent runner — the OODA loop (system-spec §5).
 *
 * Each iteration is one turn of Observe → Reason → Plan → Act → Evaluate:
 *
 *   Observe   assemble the conversation + current plan/goal state.
 *   Plan      draft/revise the task DAG in the shared TaskStore (Plan policy).
 *   Reason+Act ONE real provider run through the kernel's native tool loop
 *             (`dispatchAgent`) — the model reasons and calls tools; every
 *             tool-call/tool-result flows through the engine bus as StreamChunks.
 *   Evaluate  self-critique the step (Evaluate policy): detect failure, mark
 *             progress, and decide retry / self-correction / dynamic replanning /
 *             delegation / stop.
 *
 * The loop repeats until the goal is met, the step budget is hit, the run is
 * cancelled, or it is blocked. Coordinator-level progress (plan drafts,
 * reflections, replans, delegations) is surfaced as reasoning-channel
 * StreamChunks carrying structured `raw.agent` metadata — never a side channel.
 */

import { randomUUID } from "node:crypto";
import {
  dispatch,
  dispatchAgent,
  sumUsage,
  type Labeled,
  type RunContext,
  type RunSpec,
  type SamplingParams,
  type CancelScope,
  type ToolInterceptor,
  type Usage,
} from "@nexuscode/core";
import { userText, type ContentBlock, type Message, type StreamChunk } from "@nexuscode/shared";
import { PermissionGate, ToolRegistry, type Tool } from "@nexuscode/tools";
import type { TaskStore } from "@nexuscode/tasks";
import { agentMetaChunk } from "./events.js";
import { AsyncQueue } from "./queue.js";
import { defaultEvaluate, defaultPlan, defaultVerify } from "./policies.js";
import type { AgentRegistry } from "./roles.js";
import type {
  AgentDefinition,
  AgentGoal,
  AgentPolicies,
  AgentRunResult,
  AgentStepRecord,
  AgentStopReason,
  DelegateDirective,
  GoalAssessment,
  GoalVerdict,
  PlanDirective,
  StepToolResult,
  VerifyFn,
  VerifyInput,
} from "./types.js";

/** Everything the runner needs, wired once by the caller. */
export interface AgentDeps {
  /** The full tool set; a run gets a role-filtered view of it. */
  tools: ToolRegistry;
  /** Default permission gate (a role's `permissionMode` may replace it). */
  gate: PermissionGate;
  /** The plan/progress store the OODA loop reads and writes. */
  store: TaskStore;
  /** Specialized-agent registry, required for delegation by role name. */
  registry?: AgentRegistry;
  /** Default logical model id when neither the run nor the role specify one. */
  defaultModel?: string;
  /** Default adapter/provider id when neither the run nor the role specify one. */
  defaultAdapterId?: string;
  /** Optional Context Engine run before each step's provider dispatch (Observe). */
  contextAssembler?: RunContext["contextAssembler"];
  /** Max provider re-invocations inside one step's tool loop (default 8). */
  maxTurnsPerStep?: number;
  /**
   * Optional pre/post-tool interception seam (§24 hooks) threaded into every
   * step's native tool loop. Additive and guarded by the kernel — a throwing or
   * blocking interceptor never crashes a step.
   */
  toolInterceptor?: ToolInterceptor;
  /**
   * The explicit Evaluate-phase verification policy used when the deterministic
   * evaluator cannot judge the goal (no success criteria). Defaults to
   * {@link defaultVerify} — one tool-free provider turn per unjudged step. Pass
   * `false` to spend nothing on verification, at the cost of such runs only ever
   * finishing as `"indeterminate"`.
   */
  verify?: VerifyFn | false;
}

/** Options for a single {@link Agent.run}. */
export interface AgentRunOptions {
  /** The objective + success criteria. */
  goal: AgentGoal;
  /** Isolated initial context; defaults to a user message of the objective. */
  input?: Message[];
  /** Override the role's step budget. */
  maxSteps?: number;
  /** Retry budget for self-correction on failure (default 2). */
  maxRetries?: number;
  /**
   * How many consecutive steps whose outcome cannot be verified either way the
   * loop tolerates before stopping as `"indeterminate"` (default 1). Continuing
   * past this point cannot produce an honest verdict — the harness has no way to
   * recognize completion — so it stops and reports the uncertainty instead of
   * burning the step budget and guessing.
   */
  maxUnverifiedSteps?: number;
  /** Override the model preference. */
  model?: string;
  /** Override the adapter preference. */
  adapterId?: string;
  /** Override the permission gate (else the role's sandbox / deps gate is used). */
  gate?: PermissionGate;
  /** Override the Plan/Evaluate policies. */
  policies?: AgentPolicies;
}

/** A live agent run: a `StreamChunk` stream plus an eventual result. */
export interface AgentHandle {
  /** Labeled chunk stream — subscribe exactly like an `OrchestrationHandle`. */
  events(): AsyncIterable<Labeled<StreamChunk>>;
  /** Resolves once the loop terminates. */
  result(): Promise<AgentRunResult>;
  /** The run's cancellation scope (a child of the turn scope). */
  scope: CancelScope;
}

/** Concatenate the text of a set of content blocks. */
function blocksText(blocks: ContentBlock[]): string {
  let out = "";
  for (const b of blocks) {
    if (b.type === "text") out += b.text;
    else if (b.type === "tool_result") out += blocksText(b.content);
  }
  return out;
}

/** Build a role-filtered tool registry (`["*"]` = the full set). */
function filterTools(all: ToolRegistry, allowed: string[]): ToolRegistry {
  const filtered = new ToolRegistry();
  if (allowed.includes("*")) {
    filtered.registerAll(all.list());
    return filtered;
  }
  const seen = new Set<string>();
  for (const name of allowed) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (all.has(name)) filtered.register(all.get(name) as Tool);
  }
  return filtered;
}

/** Apply plan directives to the store, tolerating already-applied edits. */
function applyDirectives(store: TaskStore, directives: PlanDirective[]): void {
  for (const d of directives) {
    if (d.op === "add") {
      if (d.id !== undefined && store.get(d.id)) continue; // idempotent seeding
      // Drop a parent reference that does not exist yet, so a directive never
      // throws just because its (optional) parent was not seeded.
      const parentId = d.parentId !== undefined && store.get(d.parentId) ? d.parentId : undefined;
      store.create({
        title: d.title,
        ...(d.id !== undefined ? { id: d.id } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
        ...(d.deps !== undefined ? { deps: d.deps } : {}),
        ...(d.notes !== undefined ? { notes: d.notes } : {}),
        ...(d.status !== undefined ? { status: d.status } : {}),
      });
    } else {
      if (!store.get(d.id)) continue;
      store.update(d.id, {
        ...(d.status !== undefined ? { status: d.status } : {}),
        ...(d.notes !== undefined ? { notes: d.notes } : {}),
        ...(d.title !== undefined ? { title: d.title } : {}),
      });
    }
  }
}

/** The name of a delegate target (role string or explicit definition). */
function delegateRoleName(role: DelegateDirective["role"]): string {
  return typeof role === "string" ? role : role.role;
}

/**
 * The agent coordinator. Construct once with the wired dependencies, then `run`
 * a role definition against a goal, or `runRole` a shipped preset by name.
 */
export class Agent {
  private readonly deps: AgentDeps;

  constructor(deps: AgentDeps) {
    this.deps = deps;
  }

  /** Run a shipped role preset (resolved via the registry) against a goal. */
  runRole(ctx: RunContext, role: string, options: AgentRunOptions): AgentHandle {
    return this.run(ctx, this.requireRegistry().get(role), options);
  }

  /** Run a specialized agent (its own tools, sandbox, prompt) against a goal. */
  run(ctx: RunContext, def: AgentDefinition, options: AgentRunOptions): AgentHandle {
    const scope = ctx.scope.child();
    const agentRunId = `agent_${randomUUID()}`;
    const queue = new AsyncQueue<Labeled<StreamChunk>>();

    let resolveResult!: (r: AgentRunResult) => void;
    let rejectResult!: (e: unknown) => void;
    const resultPromise = new Promise<AgentRunResult>((res, rej) => {
      resolveResult = res;
      rejectResult = rej;
    });

    let finalResult: AgentRunResult | undefined;
    const source = this.oodaLoop(ctx, scope, agentRunId, def, options, (r) => {
      finalResult = r;
    });

    const labeled = ctx.bus.publish(source, { runId: agentRunId, laneIndex: 0 });
    const pump = async (): Promise<void> => {
      for await (const l of labeled) queue.push(l);
      resolveResult(finalResult as AgentRunResult);
      queue.close();
    };
    pump().catch((e: unknown) => {
      rejectResult(e);
      queue.fail(e);
    });

    return { scope, events: () => queue, result: () => resultPromise };
  }

  private requireRegistry(): AgentRegistry {
    if (!this.deps.registry) {
      throw new Error("agent: a role registry is required to run/delegate by role name");
    }
    return this.deps.registry;
  }

  /** The OODA loop as a raw `StreamChunk` generator; published by `run`. */
  private async *oodaLoop(
    ctx: RunContext,
    scope: CancelScope,
    agentRunId: string,
    def: AgentDefinition,
    options: AgentRunOptions,
    setResult: (r: AgentRunResult) => void,
  ): AsyncIterable<StreamChunk> {
    const role = def.role;
    const goal = options.goal;
    const maxSteps = options.maxSteps ?? def.maxSteps;
    const maxRetries = options.maxRetries ?? 2;
    const planFn = options.policies?.plan ?? defaultPlan;
    const evalFn = options.policies?.evaluate ?? defaultEvaluate;
    const verifyOpt = options.policies?.verify ?? this.deps.verify ?? defaultVerify;
    const verifyFn: VerifyFn | undefined = verifyOpt === false ? undefined : verifyOpt;
    const maxUnverified = Math.max(1, options.maxUnverifiedSteps ?? 1);
    const store = this.deps.store;

    const tools = filterTools(this.deps.tools, def.allowedTools);
    const toolsAvailable = tools.names();
    // Capability ceiling: the effective gate is always DERIVED from the parent
    // gate (the caller-supplied `options.gate` when this is a delegated
    // sub-agent, else the wired `deps.gate`). `deriveChild` intersects the role's
    // requested `permissionMode` with the parent's mode (never widening) and
    // carries forward the parent's denylist + approve callback — so a role can
    // never out-privilege its delegator, and an operator denylist/approver is
    // never silently dropped for a roled agent.
    const parentGate = options.gate ?? this.deps.gate;
    const gate = parentGate.deriveChild(def.permissionMode);
    const model = options.model ?? def.model ?? this.deps.defaultModel ?? "mock-tools";
    const adapterId = options.adapterId ?? def.adapterId ?? this.deps.defaultAdapterId ?? "mock";
    const maxTurns = this.deps.maxTurnsPerStep ?? 8;

    let messages: Message[] =
      options.input && options.input.length > 0 ? [...options.input] : userText(goal.objective);

    const steps: AgentStepRecord[] = [];
    const subAgents: AgentRunResult[] = [];
    const usages: Usage[] = [];
    const criterionTaskIds = (goal.successCriteria ?? []).map((_c, i) => `${agentRunId}-c${i}`);
    const rootTaskId = `${agentRunId}-root`;
    let rootCreated = false;
    let evidence = "";
    let finalText = "";
    let retriesUsed = 0;
    let stopReason: AgentStopReason = "max-steps";
    // The run's verdict is only ever as strong as the last step's evidence. It
    // starts `"indeterminate"` so a run that never completes a step (cancelled
    // before step 0) reports uncertainty rather than a negative it never tested.
    let verdict: GoalVerdict = "indeterminate";
    let unverifiedStreak = 0;

    const buildResult = (reason: AgentStopReason): AgentRunResult => {
      const progress = rootCreated ? store.progress(rootTaskId) : store.progress();
      const plan = rootCreated ? store.subtree(rootTaskId) : store.all();
      // A run that stopped for any other reason (cancelled, blocked, budget)
      // never advertises "met", even if a policy claimed it on the way out.
      const finalVerdict: GoalVerdict =
        reason === "goal-met" ? "met" : verdict === "met" ? "indeterminate" : verdict;
      return {
        role,
        goal: goal.objective,
        stopReason: reason,
        steps,
        finalText,
        plan,
        progress,
        goalMet: reason === "goal-met",
        verdict: finalVerdict,
        usage: sumUsage(usages),
        subAgents,
        systemPrompt: def.systemPrompt,
      };
    };

    for (let step = 0; step < maxSteps; step++) {
      if (scope.signal.aborted) {
        stopReason = "cancelled";
        break;
      }

      // ── OBSERVE ─────────────────────────────────────────────────────────────
      yield agentMetaChunk(agentRunId, role, "step-start", step, `Step ${step}: observing context and plan.`);

      // ── PLAN ────────────────────────────────────────────────────────────────
      const directives = planFn({ role, goal, step, idPrefix: agentRunId });
      if (directives.length > 0) {
        applyDirectives(store, directives);
        if (store.get(rootTaskId)) rootCreated = true;
        yield agentMetaChunk(
          agentRunId,
          role,
          "plan",
          step,
          `Plan updated (${directives.length} edit${directives.length === 1 ? "" : "s"}).`,
          rootCreated ? store.subtree(rootTaskId) : store.all(),
        );
      }

      // ── REASON + ACT (native tool loop through the engine) ──────────────────
      const params: SamplingParams = { system: def.systemPrompt };
      if (def.temperature !== undefined) params.temperature = def.temperature;
      const spec: RunSpec = {
        adapterId,
        model,
        input: messages,
        idempotencyKey: `${agentRunId}:s${step}`,
        params,
      };
      const inner = dispatchAgent(spec, ctx, {
        tools,
        gate,
        maxTurns,
        ...(this.deps.contextAssembler ? { contextAssembler: this.deps.contextAssembler } : {}),
        ...(this.deps.toolInterceptor ? { toolInterceptor: this.deps.toolInterceptor } : {}),
      });

      const stepToolResults: StepToolResult[] = [];
      for await (const l of inner.events()) {
        const c = l.chunk;
        if (c.type === "tool-result") {
          stepToolResults.push({
            id: c.toolCallId,
            isError: c.isError === true,
            text: blocksText(c.content),
          });
        }
        yield c;
      }
      const outcome = await inner.outcome();
      const winner = outcome.winner;
      const stepText = winner?.text ?? "";
      const stepUsage: Usage = winner?.usage ?? { inputTokens: 0, outputTokens: 0 };
      usages.push(stepUsage);
      if (stepText.trim().length > 0) finalText = stepText;

      const cancelled = winner?.status === "cancelled" || scope.signal.aborted;
      evidence += `\n${stepText}`;
      for (const tr of stepToolResults) evidence += `\n${tr.text}`;

      // ── EVALUATE / REFLECT ──────────────────────────────────────────────────
      const reflection = evalFn({
        role,
        goal,
        step,
        maxSteps,
        retriesUsed,
        maxRetries,
        outcome,
        stepText,
        toolResults: stepToolResults,
        evidence,
        criterionTaskIds,
        rootTaskId,
        cancelled,
      });
      // A policy that only sets `goalMet` still works: the boolean is the verdict.
      verdict = reflection.verdict ?? (reflection.goalMet ? "met" : "unmet");

      // ── EVALUATE (explicit) ─────────────────────────────────────────────────
      // The deterministic evaluator could not judge this step (no success
      // criteria to check against). Rather than let "the model said something"
      // stand in for "the goal is achieved", spend one tool-free provider turn
      // on an actual evaluation. Anything short of an unambiguous verdict stays
      // `"indeterminate"`.
      if (verdict === "indeterminate" && verifyFn && !cancelled && !scope.signal.aborted) {
        const assessment = await this.verifyGoal(verifyFn, {
          role,
          goal,
          step,
          stepText,
          toolResults: stepToolResults,
          evidence,
          ask: (prompt, system) =>
            this.evaluationTurn(ctx, { adapterId, model, prompt, system, key: `${agentRunId}:s${step}:evaluate` }, usages),
        });
        verdict = assessment.verdict;
        reflection.goalMet = verdict === "met";
        reflection.critique =
          verdict === "met"
            ? `Goal verified on step ${step} by explicit evaluation: ${assessment.reason}`
            : verdict === "unmet"
              ? `Evaluation on step ${step} found the objective not yet achieved: ${assessment.reason}`
              : `Step ${step} could NOT be verified (${assessment.reason}); the outcome is unknown, not successful.`;
        if (verdict === "unmet") {
          reflection.correction = `The objective is not yet achieved: ${assessment.reason}. Do the remaining work — do not restate it.`;
        }
        yield agentMetaChunk(agentRunId, role, "goal", step, reflection.critique, { assessment });
      }
      reflection.verdict = verdict;
      unverifiedStreak = verdict === "indeterminate" ? unverifiedStreak + 1 : 0;

      if (reflection.planEdits && reflection.planEdits.length > 0) {
        applyDirectives(store, reflection.planEdits);
      }
      // Closing the objective root reflects a fully-met goal in the progress bar.
      if (reflection.goalMet && rootCreated && store.get(rootTaskId)) {
        store.update(rootTaskId, { status: "done" });
      }
      reflection.progress = rootCreated ? store.progress(rootTaskId).percent : reflection.progress;

      steps.push({
        step,
        runId: winner?.runId ?? `${agentRunId}:s${step}`,
        status: winner?.status ?? "error",
        text: stepText,
        toolCalls: winner?.toolCalls ?? [],
        toolResults: stepToolResults,
        toolsAvailable: [...toolsAvailable],
        reflection,
        usage: stepUsage,
      });

      yield agentMetaChunk(agentRunId, role, "reflect", step, reflection.critique, { reflection });
      yield agentMetaChunk(agentRunId, role, "progress", step, `Progress: ${reflection.progress}%`, {
        percent: reflection.progress,
      });

      // ── DELEGATE (isolated-context sub-agent) ───────────────────────────────
      if (reflection.delegate) {
        const targetName = delegateRoleName(reflection.delegate.role);
        yield agentMetaChunk(
          agentRunId,
          role,
          "delegate",
          step,
          `Delegating a subtask to "${targetName}".`,
          { role: targetName, goal: reflection.delegate.goal.objective },
        );
        const subDef =
          typeof reflection.delegate.role === "string"
            ? this.requireRegistry().get(reflection.delegate.role)
            : reflection.delegate.role;
        // Pass THIS run's effective gate as the sub-agent's parent gate so its
        // own `deriveChild` caps the delegate's `permissionMode` against ours —
        // the capability ceiling chains monotonically down the delegation tree.
        const subHandle = this.run(ctx, subDef, {
          goal: reflection.delegate.goal,
          gate,
          ...(reflection.delegate.input ? { input: reflection.delegate.input } : {}),
        });
        for await (const l of subHandle.events()) yield l.chunk;
        const subResult = await subHandle.result();
        subAgents.push(subResult);
        usages.push(subResult.usage);
        evidence += `\n${subResult.finalText}`;
      }

      // ── DECIDE ──────────────────────────────────────────────────────────────
      if (reflection.stop) {
        stopReason = reflection.stop;
        break;
      }
      if (cancelled) {
        stopReason = "cancelled";
        break;
      }
      if (reflection.goalMet) {
        stopReason = "goal-met";
        break;
      }
      // Nothing can recognize completion for this run, so looping further would
      // only burn the budget before guessing. Stop and report the uncertainty.
      if (verdict === "indeterminate" && unverifiedStreak >= maxUnverified) {
        stopReason = "indeterminate";
        break;
      }

      if (reflection.needsReplan) {
        retriesUsed += 1;
        yield agentMetaChunk(
          agentRunId,
          role,
          "replan",
          step,
          "Reality diverged from the plan; revising it.",
          rootCreated ? store.subtree(rootTaskId) : store.all(),
        );
      }
      if (reflection.retry) {
        yield agentMetaChunk(agentRunId, role, "retry", step, "Retrying with corrective feedback.");
      }

      // Grow the conversation for the next step (the feedback loop).
      if (stepText.trim().length > 0) {
        messages = [...messages, { role: "assistant", content: [{ type: "text", text: stepText }] }];
      }
      const correction = reflection.correction ?? `Continue toward: ${goal.objective}.`;
      messages = [...messages, ...userText(correction)];
    }

    const result = buildResult(stopReason);
    yield agentMetaChunk(agentRunId, role, "stop", steps.length, `Run finished: ${stopReason}.`, {
      stopReason,
      verdict: result.verdict,
    });
    if (result.verdict === "indeterminate") {
      yield agentMetaChunk(
        agentRunId,
        role,
        "goal",
        steps.length,
        "Outcome UNVERIFIED: this run could not establish whether the objective was achieved. " +
          "Declare success criteria (goal.successCriteria) to make it checkable.",
        { verdict: result.verdict },
      );
    }
    setResult(result);
  }

  /** Run the verification policy, treating any thrown error as "unverifiable". */
  private async verifyGoal(verify: VerifyFn, input: VerifyInput): Promise<GoalAssessment> {
    try {
      return await verify(input);
    } catch (e) {
      return { verdict: "indeterminate", reason: `the evaluation step failed: ${String(e)}` };
    }
  }

  /**
   * One tool-free provider turn used by the explicit Evaluate phase. It runs on
   * its own lane (its chunks never enter the agent's own stream), its tokens are
   * accounted to the run, and a turn that does not finish cleanly — including
   * one truncated by its own output budget — returns `undefined` so the caller
   * reports uncertainty instead of parsing half an answer.
   */
  private async evaluationTurn(
    ctx: RunContext,
    opts: { adapterId: string; model: string; prompt: string; system?: string; key: string },
    usages: Usage[],
  ): Promise<string | undefined> {
    const params: SamplingParams = { temperature: 0 };
    if (opts.system !== undefined) params.system = opts.system;
    const spec: RunSpec = {
      adapterId: opts.adapterId,
      model: opts.model,
      input: userText(opts.prompt),
      idempotencyKey: opts.key,
      params,
    };
    const handle = dispatch({ kind: "single", run: spec }, ctx);
    for await (const _ of handle.events()) void _;
    const winner = (await handle.outcome()).winner;
    if (!winner) return undefined;
    usages.push(winner.usage);
    if (winner.status !== "ok" || winner.finishReason === "length") return undefined;
    return winner.text;
  }
}
