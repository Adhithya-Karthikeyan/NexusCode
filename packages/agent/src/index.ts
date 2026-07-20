/**
 * @nexuscode/agent — the agent framework (system-spec §5).
 *
 * The OODA loop (Observe → Reason → Plan → Act → Evaluate → Repeat) layered on
 * top of the kernel's native tool-execution loop: multi-step planning, reflection
 * (self-critique between steps), retry + self-correction on failure, goal &
 * progress tracking via `@nexuscode/tasks`, and dynamic replanning. Plus a
 * registry of specialized role agents (planner, coder, reviewer, tester,
 * researcher, architect, doc-writer, security-reviewer) and provider-agnostic
 * sub-agent delegation with isolated context.
 *
 * Everything a run emits — thinking, tool-calls, tool-results, plan updates,
 * reflections, replans, delegations — flows through the engine bus as ordinary
 * `StreamChunk`s (see `events.ts`); the framework never opens a parallel channel.
 */

export { Agent } from "./runner.js";
export type { AgentDeps, AgentHandle, AgentRunOptions } from "./runner.js";

export {
  createAgentRegistry,
  registerAgentPrompts,
  AGENT_ROLES,
  AGENT_PROMPT_ID,
  AGENT_PROMPT_VERSION,
} from "./roles.js";
export type { AgentRegistry } from "./roles.js";

export {
  defaultPlan,
  defaultEvaluate,
  defaultVerify,
  parseVerdict,
  VERDICT_TOKEN,
  VERIFY_SYSTEM,
} from "./policies.js";

export { agentMetaChunk, isAgentMeta } from "./events.js";
export type { AgentMeta, AgentPhase } from "./events.js";

export type {
  AgentDefinition,
  AgentGoal,
  AgentPolicies,
  AgentRole,
  AgentRunResult,
  AgentStepRecord,
  AgentStopReason,
  DelegateDirective,
  EvaluateFn,
  EvaluateInput,
  GoalAssessment,
  GoalVerdict,
  PlanDirective,
  PlanFn,
  PlanInput,
  Reflection,
  StepToolResult,
  VerifyFn,
  VerifyInput,
} from "./types.js";
