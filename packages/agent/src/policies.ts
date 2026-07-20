/**
 * The default Plan and Evaluate policies — the deterministic, offline-verifiable
 * heart of the OODA loop. The LLM performs Reason/Act (a real provider run with
 * tools); these policies perform Plan (draft/revise the task DAG) and
 * Evaluate/Reflect (self-critique the step, detect failure, mark progress, and
 * decide retry / replan / stop). Both are pure functions of their input, so a
 * run is fully reproducible against the mock provider. Callers may override
 * either via {@link import("./types.js").AgentPolicies}.
 */

import type { EvaluateInput, PlanDirective, PlanFn, Reflection } from "./types.js";

/** Normalize text for substring matching (case- and whitespace-insensitive-ish). */
function norm(s: string): string {
  return s.toLowerCase();
}

/**
 * Default Plan phase. On step 0 it drafts the plan: a root task for the
 * objective plus one child task per success criterion (each becomes a progress
 * unit). Later steps add nothing by default — replanning happens through the
 * evaluator's `planEdits`.
 */
export const defaultPlan: PlanFn = ({ goal, step, idPrefix }): PlanDirective[] => {
  if (step !== 0) return [];
  const rootId = `${idPrefix}-root`;
  const directives: PlanDirective[] = [
    { op: "add", id: rootId, title: goal.objective, status: "in_progress", notes: "objective" },
  ];
  const criteria = goal.successCriteria ?? [];
  criteria.forEach((c, i) => {
    directives.push({ op: "add", id: `${idPrefix}-c${i}`, parentId: rootId, title: c, notes: "criterion" });
  });
  return directives;
};

/**
 * Default Evaluate/Reflect phase. Folds the step into the running assessment:
 *
 *  - Marks any criterion whose text now appears in the evidence as `done`
 *    (progress tracking).
 *  - Detects failure — a tool error, a run error, or a partial outcome — and on
 *    failure blocks the outstanding criterion, appends a one-shot recovery task
 *    (dynamic replanning), and requests a retry with corrective feedback
 *    (self-correction), up to the retry budget.
 *  - Declares the goal met once every criterion is satisfied (or, when there are
 *    no criteria, after the first clean step).
 */
export function defaultEvaluate(input: EvaluateInput): Reflection {
  const {
    goal,
    outcome,
    stepText,
    toolResults,
    evidence,
    criterionTaskIds,
    rootTaskId,
    retriesUsed,
    maxRetries,
    cancelled,
    step,
  } = input;

  const criteria = goal.successCriteria ?? [];
  const planEdits: PlanDirective[] = [];

  if (cancelled) {
    return {
      critique: "The step was cancelled; stopping.",
      progress: 0,
      goalMet: false,
      failure: true,
      needsReplan: false,
      retry: false,
      stop: "cancelled",
    };
  }

  // Which criteria are now satisfied by the accumulated evidence?
  const ev = norm(evidence);
  const unmet: number[] = [];
  criteria.forEach((c, i) => {
    if (ev.includes(norm(c))) {
      const taskId = criterionTaskIds[i];
      if (taskId) planEdits.push({ op: "update", id: taskId, status: "done", notes: "satisfied" });
    } else {
      unmet.push(i);
    }
  });

  // Did this step fail? (tool error, run error, or a partial/failed outcome.)
  const toolErrored = toolResults.some((t) => t.isError);
  const runFailed = outcome.partial || (outcome.winner ? outcome.winner.status !== "ok" : true);
  const failure = toolErrored || runFailed;

  const allCriteriaMet = criteria.length > 0 && unmet.length === 0;
  const trivialMet = criteria.length === 0 && !failure && stepText.trim().length > 0;
  const goalMet = !failure && (allCriteriaMet || trivialMet);

  if (goalMet) {
    // Close the objective root and any lingering criterion tasks.
    return {
      critique: `Goal satisfied on step ${step}: every success criterion is met.`,
      progress: 100,
      goalMet: true,
      failure: false,
      needsReplan: false,
      retry: false,
      planEdits,
    };
  }

  if (failure) {
    const canRetry = retriesUsed < maxRetries;
    const failingCriterion = unmet[0];
    const failingTaskId = failingCriterion !== undefined ? criterionTaskIds[failingCriterion] : undefined;
    const detail = toolErrored
      ? toolResults.find((t) => t.isError)?.text ?? "a tool call failed"
      : outcome.winner?.error?.message ?? "the run did not complete cleanly";

    if (failingTaskId) {
      planEdits.push({ op: "update", id: failingTaskId, status: "blocked", notes: `failed: ${detail}` });
    }
    if (canRetry) {
      // Dynamic replanning: add a one-shot recovery task the next step addresses.
      planEdits.push({
        op: "add",
        id: `${input.role}-recover-${step}`,
        parentId: rootTaskId,
        title: `Recover from failure on step ${step}`,
        notes: detail,
      });
    }

    return {
      critique: `Step ${step} failed (${detail}). ${canRetry ? "Replanning and retrying." : "Retry budget exhausted; blocked."}`,
      progress: 0,
      goalMet: false,
      failure: true,
      needsReplan: canRetry,
      retry: canRetry,
      planEdits,
      ...(canRetry
        ? {
            correction: `The previous attempt failed: ${detail}. Adjust your approach and try again to satisfy: ${goal.objective}.`,
          }
        : { stop: "blocked" as const }),
    };
  }

  // No failure, but the goal is not yet met — keep going (continuation). The
  // correction deliberately does NOT echo the criteria text, so a downstream
  // step cannot accidentally "satisfy" a criterion just by quoting it back.
  return {
    critique: `Step ${step} made progress but the goal is not yet met (${unmet.length} of ${criteria.length} criteria remaining).`,
    progress: 0,
    goalMet: false,
    failure: false,
    needsReplan: false,
    retry: false,
    correction: `The objective "${goal.objective}" is not yet fully satisfied; refine your approach and continue.`,
    planEdits,
  };
}
