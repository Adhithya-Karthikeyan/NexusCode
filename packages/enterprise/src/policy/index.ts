/**
 * @nexuscode/enterprise — policy-engine barrel (system-spec §25). A declarative
 * deny-overrides rule set, a combined RBAC+policy `Authorizer`, and a HookBus
 * authorization hook the harness consults at the pre-tool gate.
 */

export type {
  AuthorizationContext,
  AuthorizationRequest,
  PolicyConditions,
  PolicyDecision,
  PolicyEffect,
  PolicyRule,
  PolicySubjects,
  TimeWindow,
} from "./types.js";

export {
  PolicyEvaluator,
  conditionsSatisfied,
  evaluateConditions,
  ruleMatches,
  type ConditionOutcome,
  type PolicyEvaluatorOptions,
} from "./evaluator.js";

export {
  Authorizer,
  costUsdFromUsage,
  type AuthorizationDecision,
  type AuthorizerOptions,
  type DecisionSource,
} from "./authorizer.js";

export {
  actionForToolPermission,
  createAuthorizationHook,
  type AuthorizationHookOptions,
} from "./hook.js";
