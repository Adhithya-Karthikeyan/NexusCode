/**
 * PolicyEvaluator — evaluate a request against a declarative rule set with
 * DENY-OVERRIDES + EXPLICIT-DENY-WINS semantics:
 *
 *   1. If ANY matching rule has `effect: "deny"` → DENY (explicit deny wins,
 *      regardless of any allow).
 *   2. Else if ANY matching rule has `effect: "allow"` → ALLOW.
 *   3. Else → DEFAULT DENY (fail closed). `matchedRule` is left undefined so a
 *      combined authorizer can tell "no policy opinion" apart from an explicit
 *      policy deny, and fall through to RBAC.
 *
 * A rule matches only when subject, action, resource all match. Conditions are
 * evaluated with THREE values (satisfied / unsatisfied / unknown) and their
 * effect on matching is DELIBERATELY ASYMMETRIC between allow and deny:
 *
 *   - ALLOW rules use GUARD semantics: the allow applies only while its
 *     conditions are provably SATISFIED. A condition that is `unsatisfied` OR
 *     `unknown` (missing context) fails the allow closed — the request falls
 *     through to default deny.
 *   - DENY rules use FAIL-CLOSED semantics: the deny applies UNLESS a condition
 *     is provably `unsatisfied` (i.e. the request is demonstrably outside the
 *     deny's scope). A condition whose context is missing (`unknown`) therefore
 *     CANNOT neutralize the deny — the deny still fires. This preserves the
 *     deny-overrides guarantee: an explicit, cost/dataClass-scoped deny can never
 *     be silently skipped by withholding request context.
 */

import { matchesAny } from "../rbac/match.js";
import type {
  AuthorizationRequest,
  PolicyConditions,
  PolicyDecision,
  PolicyRule,
  TimeWindow,
} from "./types.js";

function subjectMatches(rule: PolicyRule, req: AuthorizationRequest): boolean {
  const s = rule.subjects;
  const hasRoles = !!s?.roles && s.roles.length > 0;
  const hasPrincipals = !!s?.principals && s.principals.length > 0;
  if (!hasRoles && !hasPrincipals) return true; // untargeted ⇒ any subject
  if (hasPrincipals && s!.principals!.includes(req.principal.id)) return true;
  if (hasRoles && req.principal.roles.some((r) => s!.roles!.includes(r))) return true;
  return false;
}

function listMatches(list: readonly string[] | undefined, value: string): boolean {
  if (!list || list.length === 0) return true; // omitted ⇒ any
  if (list.includes("*")) return true;
  return matchesAny(list, value);
}

/** Convert an epoch-ms / Date to minutes-since-local-midnight. */
function minutesOfDay(now: number | Date): number {
  const d = typeof now === "number" ? new Date(now) : now;
  return d.getHours() * 60 + d.getMinutes();
}

function parseClock(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function withinWindow(win: TimeWindow, now: number | Date): boolean {
  const start = parseClock(win.start);
  const end = parseClock(win.end);
  if (start === null || end === null) return false; // malformed ⇒ closed
  const cur = minutesOfDay(now);
  // Non-wrapping window [start,end]; wrapping window (start>end) spans midnight.
  return start <= end ? cur >= start && cur <= end : cur >= start || cur <= end;
}

/**
 * Three-valued outcome of evaluating a rule's conditions against a request:
 *   - `"satisfied"`   — every declared condition provably holds;
 *   - `"unsatisfied"` — at least one condition provably does NOT hold (the
 *                       request is demonstrably outside the rule's scope);
 *   - `"unknown"`     — no condition is provably violated, but at least one
 *                       could not be evaluated because its context is missing.
 * A definite `"unsatisfied"` always dominates `"unknown"`.
 */
export type ConditionOutcome = "satisfied" | "unsatisfied" | "unknown";

/**
 * Evaluate a rule's conditions with three-valued logic. `timeWindow` is always
 * evaluable (it defaults `now` to the current clock), so only `maxCostUsd` and
 * `dataClass` can produce `"unknown"` when their context is withheld.
 */
export function evaluateConditions(
  conditions: PolicyConditions | undefined,
  req: AuthorizationRequest,
): ConditionOutcome {
  if (!conditions) return "satisfied";
  const ctx = req.context ?? {};
  let sawUnknown = false;

  if (conditions.maxCostUsd !== undefined) {
    if (typeof ctx.costUsd !== "number") sawUnknown = true; // unknown cost
    else if (ctx.costUsd > conditions.maxCostUsd) return "unsatisfied";
  }

  if (conditions.timeWindow !== undefined) {
    const now = ctx.now ?? Date.now();
    if (!withinWindow(conditions.timeWindow, now)) return "unsatisfied";
  }

  if (conditions.dataClass !== undefined) {
    if (typeof ctx.dataClass !== "string") sawUnknown = true; // unknown class
    else if (!conditions.dataClass.includes(ctx.dataClass)) return "unsatisfied";
  }

  return sawUnknown ? "unknown" : "satisfied";
}

/**
 * True when EVERY declared condition is provably satisfied by the request
 * context. Missing context for a declared condition ⇒ NOT satisfied (fail
 * closed). This is the ALLOW/guard reading of {@link evaluateConditions}.
 */
export function conditionsSatisfied(
  conditions: PolicyConditions | undefined,
  req: AuthorizationRequest,
): boolean {
  return evaluateConditions(conditions, req) === "satisfied";
}

/** True when subject + action + resource all match (conditions excluded). */
function structuralMatch(rule: PolicyRule, req: AuthorizationRequest): boolean {
  return (
    subjectMatches(rule, req) &&
    listMatches(rule.actions, req.action) &&
    listMatches(rule.resources, req.resource)
  );
}

/**
 * True when subject + action + resource + conditions all match (guard/allow
 * reading: conditions must be provably satisfied). Retained for external
 * callers; the evaluator uses effect-aware matching directly so DENY rules can
 * fail closed on unknown context.
 */
export function ruleMatches(rule: PolicyRule, req: AuthorizationRequest): boolean {
  return structuralMatch(rule, req) && conditionsSatisfied(rule.conditions, req);
}

export interface PolicyEvaluatorOptions {
  /** Initial rules. Order is preserved; the first matching deny/allow is cited. */
  rules?: readonly PolicyRule[];
}

export class PolicyEvaluator {
  private readonly rules: PolicyRule[];

  constructor(opts: PolicyEvaluatorOptions = {}) {
    this.rules = [...(opts.rules ?? [])];
  }

  /** Append a rule. Returns `this` for chaining. */
  addRule(rule: PolicyRule): this {
    this.rules.push(rule);
    return this;
  }

  /** Snapshot of the current rule set. */
  getRules(): readonly PolicyRule[] {
    return [...this.rules];
  }

  /**
   * Evaluate `request`. Explicit deny wins; otherwise first allow; otherwise
   * default deny with `matchedRule` left undefined.
   */
  evaluate(request: AuthorizationRequest): PolicyDecision {
    let firstAllow: PolicyRule | undefined;
    for (const rule of this.rules) {
      if (!structuralMatch(rule, request)) continue;
      const cond = evaluateConditions(rule.conditions, request);
      if (rule.effect === "deny") {
        // Fail-closed: a deny fires unless its condition is PROVABLY unsatisfied
        // (request demonstrably outside the deny's scope). `unknown` context can
        // never neutralize a deny — the deny-overrides guarantee holds.
        if (cond === "unsatisfied") continue;
        return {
          allowed: false,
          reason: describe(
            rule,
            cond === "unknown"
              ? "explicit deny (conditions unverifiable — fail closed)"
              : "explicit deny",
          ),
          matchedRule: rule,
        };
      }
      // Allow uses guard semantics: applies only while provably satisfied.
      if (cond !== "satisfied") continue;
      if (firstAllow === undefined) firstAllow = rule;
    }
    if (firstAllow !== undefined) {
      return {
        allowed: true,
        reason: describe(firstAllow, "allow"),
        matchedRule: firstAllow,
      };
    }
    return {
      allowed: false,
      reason: "default deny: no matching policy rule (fail closed)",
    };
  }
}

function describe(rule: PolicyRule, kind: string): string {
  const label = rule.id ? `rule "${rule.id}"` : "policy rule";
  const note = rule.description ? ` — ${rule.description}` : "";
  return `${label}: ${kind}${note}`;
}
