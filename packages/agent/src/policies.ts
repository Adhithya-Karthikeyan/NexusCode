/**
 * The default Plan and Evaluate policies — the deterministic, offline-verifiable
 * heart of the OODA loop. The LLM performs Reason/Act (a real provider run with
 * tools); these policies perform Plan (draft/revise the task DAG) and
 * Evaluate/Reflect (self-critique the step, detect failure, mark progress, and
 * decide retry / replan / stop). {@link defaultPlan} and {@link defaultEvaluate}
 * are pure functions of their input, so a run is fully reproducible against the
 * mock provider. Callers may override any of them via
 * {@link import("./types.js").AgentPolicies}.
 *
 * ## Honest success signalling
 *
 * A goal is reported as MET only on evidence:
 *
 *  1. **Deterministic** — every declared success criterion appears in the
 *     accumulated evidence. This is the caller's explicit contract and the only
 *     offline path to `"met"`.
 *  2. **Model-driven** — when no criteria were declared, the Evaluate phase
 *     spends one explicit, tool-free provider turn asking for a strict verdict
 *     ({@link defaultVerify}).
 *  3. **Neither** — the run reports `"indeterminate"` and says so.
 *
 * Producing text is NOT evidence of achievement, so a clean step with no
 * criteria and no verdict can never be `"met"`.
 */

import type {
  EvaluateInput,
  GoalAssessment,
  PlanDirective,
  PlanFn,
  Reflection,
  VerifyFn,
} from "./types.js";

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
 *  - Declares the goal met once every criterion is satisfied. With NO criteria
 *    there is nothing to check against, so it returns `"indeterminate"` — the
 *    runner then attempts the explicit model-driven evaluation, and reports an
 *    unverified outcome if that cannot settle it either.
 */
export function defaultEvaluate(input: EvaluateInput): Reflection {
  const {
    goal,
    outcome,
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
      verdict: "indeterminate",
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
  //
  // `budgetExhausted` is the honesty case the kernel cannot express: a run that
  // burns its whole turn/output budget terminates with `finishReason: "length"`
  // but `status: "ok"`, because "ok" only means the transport did not fault. A
  // step that ran out of budget mid-task did NOT finish its work, so the agent
  // treats it as a failed step — it must never be a stepping stone to "met".
  const toolErrored = toolResults.some((t) => t.isError);
  const budgetExhausted = outcome.winner?.finishReason === "length";
  const runFailed = outcome.partial || (outcome.winner ? outcome.winner.status !== "ok" : true);
  const failure = toolErrored || runFailed || budgetExhausted;

  const allCriteriaMet = criteria.length > 0 && unmet.length === 0;
  const goalMet = !failure && allCriteriaMet;

  if (goalMet) {
    // Close the objective root and any lingering criterion tasks.
    return {
      critique: `Goal satisfied on step ${step}: every success criterion is met.`,
      progress: 100,
      goalMet: true,
      verdict: "met",
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
      : budgetExhausted
        ? "the step exhausted its turn/output budget before finishing"
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
      verdict: "unmet",
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

  // A clean step with NO declared criteria: there is nothing to check the work
  // against, so this policy cannot honestly call it done — emitting text is not
  // evidence of achievement. Hand the question to the runner's explicit
  // model-driven evaluation; if that cannot settle it either, the run ends as
  // unverified rather than pretending.
  if (criteria.length === 0) {
    return {
      critique:
        `Step ${step} completed cleanly, but this goal declares no success criteria, ` +
        `so the step's output alone does not establish that the objective was achieved.`,
      progress: 0,
      goalMet: false,
      verdict: "indeterminate",
      failure: false,
      needsReplan: false,
      retry: false,
      planEdits,
    };
  }

  // No failure, but the goal is not yet met — keep going (continuation). The
  // correction deliberately does NOT echo the criteria text, so a downstream
  // step cannot accidentally "satisfy" a criterion just by quoting it back.
  return {
    critique: `Step ${step} made progress but the goal is not yet met (${unmet.length} of ${criteria.length} criteria remaining).`,
    progress: 0,
    goalMet: false,
    verdict: "unmet",
    failure: false,
    needsReplan: false,
    retry: false,
    correction: `The objective "${goal.objective}" is not yet fully satisfied; refine your approach and continue.`,
    planEdits,
  };
}

// ── Explicit (model-driven) Evaluate step ─────────────────────────────────────

/**
 * The one-line contract the evaluation turn must answer with. A distinctive
 * token (rather than a bare "YES"/"NO") makes the verdict machine-detectable
 * inside otherwise free-form text.
 */
export const VERDICT_TOKEN = "NEXUS_GOAL_VERDICT:";

/** The evaluator's system prompt: sceptical, evidence-only, no assumptions. */
export const VERIFY_SYSTEM =
  "You are a strict, sceptical evaluator. You judge ONLY from the evidence you are shown. " +
  "You never assume that unstated work happened, and you never reward intent, restatement, or plans.";

/** Upper bound on the evidence handed to the evaluator (most recent characters). */
const MAX_EVIDENCE_CHARS = 4_000;

/**
 * Parse an evaluation turn's answer into a verdict.
 *
 * The parse is deliberately unforgiving, because the failure mode it guards
 * against is a model that simply echoes its instructions back (exactly what the
 * mock provider — and a confused real one — does): the prompt names BOTH verdict
 * tokens, so an echo yields two conflicting matches and resolves to
 * `"indeterminate"`. Anything other than exactly one distinct verdict is
 * `"indeterminate"`; there is no lenient fallback that could invent a pass.
 */
export function parseVerdict(answer: string): GoalAssessment {
  const re = /NEXUS_GOAL_VERDICT:\s*(MET|NOT_MET)\b/g;
  const found = new Set<string>();
  let reason = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    found.add(m[1] as string);
    if (reason.length === 0) {
      reason = (answer.slice(re.lastIndex).split("\n")[0] ?? "").replace(/^[\s\-–—:.]+/, "").trim();
    }
  }
  if (found.size !== 1) {
    return {
      verdict: "indeterminate",
      reason:
        found.size === 0
          ? "the evaluation did not return a usable verdict"
          : "the evaluation returned conflicting verdicts",
    };
  }
  const met = found.has("MET");
  return {
    verdict: met ? "met" : "unmet",
    reason:
      reason.length > 0
        ? reason
        : met
          ? "the evaluator judged the objective satisfied"
          : "the evaluator judged the objective not yet satisfied",
  };
}

/**
 * The default explicit Evaluate step: one tool-free provider turn that asks the
 * model to judge the objective against the accumulated evidence and answer in a
 * fixed, parseable form.
 *
 * Every uncertain path resolves to `"indeterminate"` — no evidence, an
 * evaluation run that did not complete, an unparseable or self-contradicting
 * answer. The only way out is an unambiguous verdict.
 */
export const defaultVerify: VerifyFn = async ({ goal, evidence, ask }): Promise<GoalAssessment> => {
  const trimmed = evidence.trim();
  if (trimmed.length === 0) {
    return { verdict: "indeterminate", reason: "the step produced no evidence to evaluate" };
  }
  const shown =
    trimmed.length > MAX_EVIDENCE_CHARS ? `…${trimmed.slice(-MAX_EVIDENCE_CHARS)}` : trimmed;
  const criteria = goal.successCriteria ?? [];

  const prompt = [
    "Decide whether the OBJECTIVE below has been FULLY achieved, judging ONLY from the EVIDENCE.",
    "Describing, restating, planning, or promising the work is NOT achieving it.",
    "If the evidence does not show the work actually done, the answer is NOT_MET.",
    "",
    `OBJECTIVE:\n${goal.objective}`,
    ...(criteria.length > 0
      ? ["", `REQUIRED CRITERIA:\n${criteria.map((c) => `- ${c}`).join("\n")}`]
      : []),
    "",
    `EVIDENCE:\n${shown}`,
    "",
    "Reply with EXACTLY one line and nothing else, in one of these two forms:",
    `${VERDICT_TOKEN} MET - <one sentence of justification>`,
    `${VERDICT_TOKEN} NOT_MET - <one sentence naming what is missing>`,
  ].join("\n");

  const answer = await ask(prompt, VERIFY_SYSTEM);
  if (answer === undefined) {
    return { verdict: "indeterminate", reason: "the evaluation run did not complete" };
  }
  return parseVerdict(answer);
};
