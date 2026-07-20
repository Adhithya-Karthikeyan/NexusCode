/**
 * The agent framework's public shapes (system-spec §5). Everything here is
 * defined purely over the frozen kernel primitives — `RunContext`,
 * `OrchestrationOutcome`, `StreamChunk`, `Usage` — plus the task model from
 * `@nexuscode/tasks`. The agent loop NEVER invents a parallel event channel: a
 * run's progress is surfaced as ordinary `StreamChunk`s on the engine bus (see
 * `events.ts`), and its plan lives in a real `TaskStore`.
 */

import type { OrchestrationOutcome, RunStatus, ToolCall, Usage } from "@nexuscode/core";
import type { Message } from "@nexuscode/shared";
import type { PermissionMode } from "@nexuscode/tools";
import type { Progress, Task, TaskStatus } from "@nexuscode/tasks";

/** The specialized roles the framework ships as presets. */
export type AgentRole =
  | "coordinator"
  | "planner"
  | "coder"
  | "reviewer"
  | "tester"
  | "researcher"
  | "architect"
  | "doc-writer"
  | "security-reviewer";

/**
 * A role preset: the immutable definition of a specialized agent. Produced by
 * the {@link AgentRegistry} (its `systemPrompt` is assembled via
 * `@nexuscode/prompt`) and consumed by the runner. Custom roles are just an
 * `AgentDefinition` the caller builds directly.
 */
export interface AgentDefinition {
  /** Stable role name, e.g. `"reviewer"`. */
  role: string;
  /** The system prompt (assembled via the PromptEngine). */
  systemPrompt: string;
  /** Tool-name allowlist. `["*"]` grants every registered tool. */
  allowedTools: string[];
  /** Hard cap on OODA iterations for this role. */
  maxSteps: number;
  /** Sandbox class; when set, the run gets a fresh gate in this mode. */
  permissionMode?: PermissionMode;
  /** Preferred logical model id (the run may override). */
  model?: string;
  /** Preferred provider/adapter id (the run may override). */
  adapterId?: string;
  /** Sampling temperature. */
  temperature?: number;
}

/** What the agent is trying to achieve, and how success is judged. */
export interface AgentGoal {
  /** One-line statement of the objective. */
  objective: string;
  /**
   * Optional success predicates. The default evaluator treats each as satisfied
   * once its text appears in the accumulated evidence (step output + tool
   * results). Each becomes a tracked task, so progress is measurable.
   *
   * When omitted, the harness has NO deterministic way to judge the objective,
   * so the Evaluate phase falls back to an explicit model-driven evaluation
   * ({@link VerifyFn}); if that cannot reach a verdict either, the run reports
   * {@link GoalVerdict} `"indeterminate"` — it never assumes success.
   */
  successCriteria?: string[];
}

/**
 * The three-valued outcome of the Evaluate phase. `"indeterminate"` is a
 * first-class result: it means the harness could NOT establish whether the
 * objective was achieved. It is never collapsed into `"met"` — a run that
 * cannot be verified says so instead of claiming success.
 */
export type GoalVerdict = "met" | "unmet" | "indeterminate";

/** Why the OODA loop stopped. */
export type AgentStopReason =
  | "goal-met"
  | "max-steps"
  | "blocked"
  | "cancelled"
  /** The loop stopped because the outcome could not be verified either way. */
  | "indeterminate"
  | "error";

/**
 * The Evaluate/Reflect verdict for one step — the self-critique that drives
 * retry, self-correction, and dynamic replanning. Returned by the evaluator
 * policy; the runner applies its `planEdits` and fills in `progress`.
 */
export interface Reflection {
  /** Human-readable self-critique, surfaced as a reasoning chunk. */
  critique: string;
  /** Percent complete (0–100), computed from the task plan by the runner. */
  progress: number;
  /** True once every success criterion is satisfied. */
  goalMet: boolean;
  /**
   * The three-valued Evaluate verdict. Authoritative when present; the runner
   * fills it in (and keeps `goalMet === (verdict === "met")`) before recording
   * the step, so a policy that only sets `goalMet` keeps working. Return
   * `"indeterminate"` when the evidence does not settle the question — the
   * runner will attempt a model-driven evaluation and, failing that, stop the
   * run honestly rather than declare success.
   */
  verdict?: GoalVerdict;
  /** True when this step failed (tool error, run error, or partial outcome). */
  failure: boolean;
  /** Ask the coordinator to revise the plan before continuing. */
  needsReplan: boolean;
  /** Re-attempt the objective on the next step with corrective feedback. */
  retry: boolean;
  /** Corrective feedback appended to the conversation for the next step. */
  correction?: string;
  /** Task mutations to apply (mark done/blocked, add recovery tasks). */
  planEdits?: PlanDirective[];
  /** Delegate a subtask to a specialized sub-agent before continuing. */
  delegate?: DelegateDirective;
  /** Force a terminal stop with this reason (overrides the default flow). */
  stop?: AgentStopReason;
}

/** A single plan mutation the runner applies to the {@link import("@nexuscode/tasks").TaskStore}. */
export type PlanDirective =
  | {
      op: "add";
      title: string;
      id?: string;
      parentId?: string;
      deps?: string[];
      notes?: string;
      status?: TaskStatus;
    }
  | { op: "update"; id: string; status?: TaskStatus; notes?: string | null; title?: string };

/** Instruction to spawn a specialized sub-agent with isolated context. */
export interface DelegateDirective {
  /** The sub-agent's role (resolved via the registry) or an explicit definition. */
  role: string | AgentDefinition;
  /** The sub-agent's goal. */
  goal: AgentGoal;
  /** Isolated initial context; defaults to a fresh message from the sub-goal. */
  input?: Message[];
}

/** The record of one OODA iteration. */
export interface AgentStepRecord {
  /** Zero-based step index. */
  step: number;
  /** The provider run id for this step's Reason/Act phase. */
  runId: string;
  /** Terminal status of the step's run. */
  status: RunStatus;
  /** The assistant's final text for the step. */
  text: string;
  /** Tool calls the model made this step. */
  toolCalls: ToolCall[];
  /** Tool results observed this step (including gate denials / errors). */
  toolResults: StepToolResult[];
  /** Tools the step was permitted to call (the role allowlist, resolved). */
  toolsAvailable: string[];
  /** The Evaluate/Reflect verdict for the step. */
  reflection: Reflection;
  /** Aggregated usage for the step. */
  usage: Usage;
}

/** A normalized tool outcome captured from the step's chunk stream. */
export interface StepToolResult {
  id: string;
  isError: boolean;
  text: string;
}

/** The full outcome of an agent run. */
export interface AgentRunResult {
  /** The role that ran. */
  role: string;
  /** The objective pursued. */
  goal: string;
  /** Why the loop terminated. */
  stopReason: AgentStopReason;
  /** Per-step audit trail. */
  steps: AgentStepRecord[];
  /** The final assistant text (the last successful step's answer). */
  finalText: string;
  /** The plan (task snapshot) at termination. */
  plan: Task[];
  /** Progress over the plan at termination. */
  progress: Progress;
  /**
   * Whether the goal was achieved. True ONLY for a `"met"` {@link verdict} — an
   * unverifiable run reports `false` with `verdict: "indeterminate"`.
   */
  goalMet: boolean;
  /** The final three-valued verdict (see {@link GoalVerdict}). */
  verdict: GoalVerdict;
  /** Run-wide usage (sum over steps and sub-agents). */
  usage: Usage;
  /** Results of any delegated sub-agents, in delegation order. */
  subAgents: AgentRunResult[];
  /** The system prompt used (the role's assembled prompt). */
  systemPrompt: string;
}

/** Inputs handed to a {@link PlanFn}. */
export interface PlanInput {
  role: string;
  goal: AgentGoal;
  step: number;
  /** Client-stable id prefix for tasks this planner creates. */
  idPrefix: string;
}

/** Inputs handed to an {@link EvaluateFn}. */
export interface EvaluateInput {
  role: string;
  goal: AgentGoal;
  step: number;
  maxSteps: number;
  retriesUsed: number;
  maxRetries: number;
  /** The provider outcome for the step's Reason/Act phase. */
  outcome: OrchestrationOutcome;
  /** The step's final assistant text. */
  stepText: string;
  /** Tool results observed this step. */
  toolResults: StepToolResult[];
  /** Accumulated evidence across all steps so far (text + tool output). */
  evidence: string;
  /** Task ids tracking each success criterion (aligned with `goal.successCriteria`). */
  criterionTaskIds: string[];
  /** The id of the plan's root task (recovery tasks attach under it). */
  rootTaskId: string;
  /** True if the step's run was cancelled. */
  cancelled: boolean;
}

/** A verdict plus the justification behind it. */
export interface GoalAssessment {
  verdict: GoalVerdict;
  /** Why — surfaced in the critique and (for `"unmet"`) fed back as correction. */
  reason: string;
}

/** Inputs handed to a {@link VerifyFn}. */
export interface VerifyInput {
  role: string;
  goal: AgentGoal;
  step: number;
  /** The step's final assistant text. */
  stepText: string;
  /** Tool results observed this step. */
  toolResults: StepToolResult[];
  /** Accumulated evidence across all steps so far (text + tool output). */
  evidence: string;
  /**
   * Run ONE tool-free provider turn (the explicit Evaluate call) and return its
   * text. Resolves to `undefined` when the evaluation run did not complete
   * cleanly — which the verifier must treat as `"indeterminate"`, never as a
   * pass. Injected by the runner so this policy stays dependency-clean and
   * unit-testable offline.
   */
  ask: (prompt: string, system?: string) => Promise<string | undefined>;
}

/** The Plan-phase policy: produce/revise tasks for the plan. */
export type PlanFn = (input: PlanInput) => PlanDirective[];

/** The Evaluate/Reflect-phase policy: critique the step and steer the loop. */
export type EvaluateFn = (input: EvaluateInput) => Reflection;

/**
 * The explicit Evaluate-phase verification policy: decide whether the objective
 * is actually achieved when the deterministic evaluator cannot tell. It MUST
 * return `"indeterminate"` rather than guess.
 */
export type VerifyFn = (input: VerifyInput) => Promise<GoalAssessment> | GoalAssessment;

/** Overridable policies for a single run (all default to the built-ins). */
export interface AgentPolicies {
  plan?: PlanFn;
  evaluate?: EvaluateFn;
  /**
   * Override the model-driven verification step, or pass `false` to disable it
   * — with it disabled, a run with no success criteria can only ever finish as
   * `"indeterminate"` (it will never be reported as met).
   */
  verify?: VerifyFn | false;
}
