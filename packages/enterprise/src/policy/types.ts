/**
 * Policy-engine types (system-spec §25 Enterprise / §18 Security). A declarative
 * rule set evaluated with DENY-OVERRIDES + EXPLICIT-DENY-WINS semantics on top
 * of (and able to override) RBAC grants.
 *
 * A rule matches a request when ALL of these hold:
 *   - subjects  — the request principal's id or one of its roles is listed
 *                 (an omitted `subjects` matches any subject);
 *   - actions   — the action is listed or `"*"` (omitted matches any action);
 *   - resources — the resource matches a listed `*`-glob (omitted matches any);
 *   - conditions— every present condition is SATISFIED by the request context.
 *
 * Conditions are GUARDS: a rule only applies while its conditions hold. A cost
 * cap on an ALLOW rule therefore means "allowed up to this cost" — an
 * over-budget request stops matching the allow and falls through to default
 * deny. Missing context for a declared condition fails the condition (closed).
 */

import type { Principal } from "../rbac/types.js";

export type PolicyEffect = "allow" | "deny";

/** Who a rule targets. Omitted (or all-empty) ⇒ matches any subject. */
export interface PolicySubjects {
  roles?: readonly string[];
  principals?: readonly string[];
}

/** A daily [start,end] clock window in local `HH:MM`, inclusive; wraps midnight. */
export interface TimeWindow {
  start: string;
  end: string;
}

/** Declarative guards on a rule. Every present key must be satisfied. */
export interface PolicyConditions {
  /** The rule applies only when the request's estimated cost ≤ this cap (USD). */
  maxCostUsd?: number;
  /** The rule applies only when `context.now` falls inside this daily window. */
  timeWindow?: TimeWindow;
  /** The rule applies only when `context.dataClass` is one of these classes. */
  dataClass?: readonly string[];
}

export interface PolicyRule {
  /** Optional stable id surfaced as `matchedRule` and in audit records. */
  id?: string;
  effect: PolicyEffect;
  subjects?: PolicySubjects;
  actions?: readonly string[];
  resources?: readonly string[];
  conditions?: PolicyConditions;
  /** Free-form note echoed into the decision reason. */
  description?: string;
}

/** Runtime facts a rule's conditions are evaluated against. */
export interface AuthorizationContext {
  /** Estimated USD cost of the request (for `maxCostUsd`). */
  costUsd?: number;
  /** Evaluation time (epoch ms or Date) for `timeWindow`. Defaults to now. */
  now?: number | Date;
  /** Data classification involved in the request (for `dataClass`). */
  dataClass?: string;
}

/** A single authorization question posed to the policy engine / authorizer. */
export interface AuthorizationRequest {
  principal: Principal;
  action: string;
  resource: string;
  context?: AuthorizationContext;
}

/** The verdict from {@link PolicyEvaluator.evaluate}. */
export interface PolicyDecision {
  allowed: boolean;
  /** Human-readable justification, safe to log. */
  reason: string;
  /** The rule that decided the outcome, when one matched. */
  matchedRule?: PolicyRule;
}
