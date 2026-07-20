/**
 * @nexuscode/enterprise — the enterprise subsystem (system-spec §25).
 *
 * This entry point ships two of the §25 pillars:
 *
 *  - **Audit log** — an append-only, redacted, TAMPER-EVIDENT record of every
 *    security-relevant event (auth, run start/end, tool call + approval,
 *    config change, RBAC/policy decision, provider-key access). Each record is
 *    hash-chained (`hash = SHA256(prevHash + canonical(record))`), so any edit,
 *    reorder, insert or delete is detectable by `verify()`. Secrets are scrubbed
 *    before a record is committed, reusing the same redaction pass as tool
 *    arguments / traces. Persists to an NDJSON file with owner-only perms.
 *
 *  - **Usage analytics** — aggregate the frozen `Usage` struct + `computeCost`
 *    per principal / role / provider / model over day / week / month windows,
 *    fed from `run_summary` rows or live run events, with CSV / JSON export.
 *
 * Everything is offline-verifiable: no external identity provider, in-memory or
 * temp-file stores only.
 */

// ── Audit log ────────────────────────────────────────────────────────────────
export { AuditLog, readNdjsonRecords, verifyChain, REDACTED } from "./audit/log.js";
export type { AuditLogOptions } from "./audit/log.js";
export { GENESIS_HASH, AUDIT_RECORD_VERSION, canonicalize, computeHash } from "./audit/hashchain.js";
export type { HashableRecord } from "./audit/hashchain.js";
export { resolveAuditKey, auditKeyRef, DEFAULT_AUDIT_KEY_REF } from "./audit/key.js";
export type {
  AuditAction,
  AuditDecision,
  AuditInput,
  AuditQuery,
  AuditRecord,
  AuditTamper,
  AuditVerifyResult,
} from "./audit/types.js";

// ── Usage analytics ──────────────────────────────────────────────────────────
export { UsageStore } from "./analytics/store.js";
export type { RunSummaryLike, UsageStoreOptions } from "./analytics/store.js";
export { bucketOf } from "./analytics/window.js";
export { toCsv, toJson } from "./analytics/export.js";
export { UNATTRIBUTED_PRINCIPAL } from "./analytics/types.js";
export type {
  BreakdownKey,
  PricingResolver,
  TimeWindow,
  UsageEntry,
  UsageQuery,
  UsageReport,
  UsageRow,
  UsageTotals,
} from "./analytics/types.js";

// ── RBAC ─────────────────────────────────────────────────────────────────────
// A fail-closed, allow-only permission model over provider/model/tool/command/
// agent-role resources, backed by config/file roles + built-ins.
export {
  RESOURCE_TYPES,
  BUILTIN_ROLES,
  DEFAULT_ROLE_NAME,
  ROLE_ADMIN,
  ROLE_DEFAULT,
  ROLE_DEVELOPER,
  ROLE_VIEWER,
  matchesAny,
  matchesPattern,
  patternToRegExp,
  RoleStore,
  parseResource,
} from "./rbac/index.js";
export type {
  Action,
  Grant,
  Principal,
  RbacDecision,
  ResourceType,
  Role,
  RoleStoreData,
  RoleStoreOptions,
} from "./rbac/index.js";

// ── Policy engine ────────────────────────────────────────────────────────────
// Declarative deny-overrides rules, a combined RBAC+policy Authorizer, and a
// HookBus authorization hook consulted at the pre-tool gate. `TimeWindow` here
// is a clock window and is aliased `PolicyTimeWindow` to avoid colliding with
// the analytics day/week/month `TimeWindow` above.
export {
  PolicyEvaluator,
  conditionsSatisfied,
  evaluateConditions,
  ruleMatches,
  Authorizer,
  costUsdFromUsage,
  actionForToolPermission,
  createAuthorizationHook,
} from "./policy/index.js";
export type {
  ConditionOutcome,
  AuthorizationContext,
  AuthorizationRequest,
  AuthorizationDecision,
  AuthorizerOptions,
  DecisionSource,
  PolicyConditions,
  PolicyDecision,
  PolicyEffect,
  PolicyEvaluatorOptions,
  PolicyRule,
  PolicySubjects,
  AuthorizationHookOptions,
  TimeWindow as PolicyTimeWindow,
} from "./policy/index.js";

// ── Private model gateways ───────────────────────────────────────────────────
// Route provider traffic through a corporate proxy: override an adapter's
// baseURL + inject required headers + optional egress allowlist, over the frozen
// provider baseURL/headers seam. Per-provider or global via a GatewaySet.
export {
  applyGateway,
  applyGatewaySet,
  resolveGateway,
  isEgressAllowed,
  hostOf,
  GatewayEgressError,
} from "./gateway/index.js";
export type {
  GatewayConfig,
  GatewaySet,
  GatewayableProviderConfig,
} from "./gateway/index.js";

// ── Wiring ───────────────────────────────────────────────────────────────────
// The single `EnterpriseServices` bundle the harness plugs into the existing
// PermissionGate / hook bus / router / server-auth seams. Off/inert unless
// `config.enterprise.mode === "on"`.
export {
  EnterpriseServices,
  buildEnterpriseServices,
} from "./wire/index.js";
export type {
  EnterpriseServicesOptions,
  EnterpriseAuthorization,
  EnterpriseWireConfig,
  EnterpriseMode,
  EnterprisePrincipal,
  EnterpriseAuditConfig,
  EnterpriseGatewaysConfig,
} from "./wire/index.js";

// ── Cost controls ────────────────────────────────────────────────────────────
// Budgets per principal/role/org (limitUsd × run|day|month window) fed from the
// frozen Usage accounting; enforce() returns allow|warn|deny|downgrade as a
// pre-run gate; record()/recordUsage() accrue post-run spend. Integrates with
// the router (applyDecisionToRoute) and the hook bus (costPreRunHook /
// costPostRunHook) without rewriting either.
export {
  CostController,
  InMemoryBudgetStore,
  FileBudgetStore,
  windowBucket,
  warnThresholdOf,
  projectCost,
  costPreRunHook,
  costPostRunHook,
  applyDecisionToRoute,
  parseDowngradeTarget,
} from "./cost/index.js";
export type {
  Budget,
  BudgetScope,
  BudgetWindow,
  BudgetStatus,
  BudgetStore,
  CostControllerOptions,
  CostPrincipal,
  Clock,
  EnforceDecision,
  EnforceResult,
  OnExceed,
  SpendRecord,
  RouteTargetLike,
  PreRunVerdict,
  PreRunPayloadLike,
  PostRunPayloadLike,
} from "./cost/index.js";
