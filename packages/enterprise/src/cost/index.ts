/** Cost controls — public surface (system-spec §25). */

export type {
  Budget,
  BudgetScope,
  BudgetWindow,
  BudgetStatus,
  BudgetStore,
  CostPrincipal,
  EnforceDecision,
  EnforceResult,
  OnExceed,
  SpendRecord,
} from "./types.js";
export { InMemoryBudgetStore, FileBudgetStore } from "./store.js";
export { windowBucket, warnThresholdOf, projectCost, type Clock } from "./budget.js";
export { CostController, type CostControllerOptions } from "./enforce.js";
export {
  costPreRunHook,
  costPostRunHook,
  applyDecisionToRoute,
  parseDowngradeTarget,
  type RouteTargetLike,
  type PreRunVerdict,
  type PreRunPayloadLike,
  type PostRunPayloadLike,
} from "./integrate.js";
