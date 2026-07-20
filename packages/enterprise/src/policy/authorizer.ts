/**
 * Authorizer — the single decision source that combines the policy engine with
 * RBAC, giving policy its override power:
 *
 *   1. Policy EXPLICIT DENY  → deny (overrides any RBAC grant).
 *   2. Policy ALLOW          → allow.
 *   3. No policy opinion      → fall through to RBAC `can` (itself fail-closed).
 *
 * Step 3 is why a policy set with zero matching rules does NOT block everything:
 * "default deny" from the evaluator means "no opinion here", so RBAC still gets
 * to grant. An EXPLICIT deny rule, by contrast, always wins.
 *
 * This is the object the PermissionGate / HookBus consult (see ./hook.ts).
 */

import { computeCost, type Pricing, type Usage } from "@nexuscode/shared";

import { RoleStore } from "../rbac/role-store.js";
import { PolicyEvaluator } from "./evaluator.js";
import type {
  AuthorizationRequest,
  PolicyDecision,
  PolicyRule,
} from "./types.js";

/** Where the final decision came from. */
export type DecisionSource = "policy" | "rbac";

export interface AuthorizationDecision {
  allowed: boolean;
  reason: string;
  source: DecisionSource;
  /** Set when policy decided the outcome. */
  matchedRule?: PolicyRule;
}

export interface AuthorizerOptions {
  roleStore: RoleStore;
  evaluator?: PolicyEvaluator;
}

export class Authorizer {
  private readonly roleStore: RoleStore;
  private readonly evaluator: PolicyEvaluator;

  constructor(opts: AuthorizerOptions) {
    this.roleStore = opts.roleStore;
    this.evaluator = opts.evaluator ?? new PolicyEvaluator();
  }

  /** The raw policy verdict (no RBAC fallthrough). */
  evaluatePolicy(request: AuthorizationRequest): PolicyDecision {
    return this.evaluator.evaluate(request);
  }

  /**
   * The combined decision. Explicit policy deny wins; else policy allow; else
   * RBAC decides. Always returns a decision — never throws for a denial.
   */
  authorize(request: AuthorizationRequest): AuthorizationDecision {
    const policy = this.evaluator.evaluate(request);
    // An explicit deny (a rule matched with effect "deny") overrides everything.
    if (policy.matchedRule?.effect === "deny") {
      return {
        allowed: false,
        reason: policy.reason,
        source: "policy",
        matchedRule: policy.matchedRule,
      };
    }
    // An explicit allow settles it too.
    if (policy.matchedRule?.effect === "allow" && policy.allowed) {
      return {
        allowed: true,
        reason: policy.reason,
        source: "policy",
        matchedRule: policy.matchedRule,
      };
    }
    // No policy opinion → RBAC (fail-closed).
    const rbac = this.roleStore.explain(
      request.principal,
      request.action,
      request.resource,
    );
    return { allowed: rbac.allowed, reason: rbac.reason, source: "rbac" };
  }
}

/**
 * Build the `context.costUsd` a `maxCostUsd` condition reads from a normalized
 * {@link Usage} record + config {@link Pricing}, reusing the frozen cost seam so
 * cost policy and cost accounting never diverge.
 */
export function costUsdFromUsage(usage: Usage, pricing: Pricing): number {
  return computeCost(usage, pricing);
}
