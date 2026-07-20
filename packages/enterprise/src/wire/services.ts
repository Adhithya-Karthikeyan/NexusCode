/**
 * EnterpriseServices — the single object the harness wires enterprise
 * enforcement through (system-spec §25). It assembles, from one
 * {@link EnterpriseWireConfig}, every §25 pillar as live, cooperating objects:
 *
 *   - RBAC       {@link RoleStore} (fail-closed, allow-only) + principal directory
 *   - Policy     {@link Authorizer} (RBAC + deny-overrides {@link PolicyEvaluator})
 *   - Cost       {@link CostController} (pre-run gate + post-run accrual)
 *   - Audit      {@link AuditLog} (append-only, redacted, hash-chained)
 *   - Analytics  {@link UsageStore} (per principal/role/provider/model)
 *   - Gateways   a {@link GatewaySet} applied to provider configs at construction
 *
 * NOTHING here rewrites the PermissionGate, the hook bus, or the router: the
 * authorization decision is exposed as (a) a `pre-tool` HookHandler, (b) a plain
 * `authorize()` the REST server calls per request, and (c) a cost pre/post-run
 * pair — each plugging into an EXISTING seam. When `mode !== "on"` the bundle is
 * inert: `enabled` is false and callers skip every check, so single-user
 * behavior is unchanged.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

import type { Pricing, Usage } from "@nexuscode/shared";
import type { HookHandler } from "@nexuscode/hooks";

import { RoleStore } from "../rbac/role-store.js";
import { DEFAULT_ROLE_NAME } from "../rbac/builtin-roles.js";
import type { Principal } from "../rbac/types.js";
import { PolicyEvaluator } from "../policy/evaluator.js";
import { Authorizer, type AuthorizationDecision } from "../policy/authorizer.js";
import { createAuthorizationHook } from "../policy/hook.js";
import type { AuthorizationContext } from "../policy/types.js";
import { CostController } from "../cost/enforce.js";
import { InMemoryBudgetStore } from "../cost/store.js";
import type { Clock } from "../cost/budget.js";
import type {
  BudgetStore,
  CostPrincipal,
  EnforceResult,
} from "../cost/types.js";
import { AuditLog } from "../audit/log.js";
import type { AuditInput, AuditRecord } from "../audit/types.js";
import { UsageStore } from "../analytics/store.js";
import type { PricingResolver } from "../analytics/types.js";
import type { GatewaySet } from "../gateway/types.js";
import type { EnterpriseWireConfig } from "./types.js";

/** Options for {@link buildEnterpriseServices}. */
export interface EnterpriseServicesOptions {
  /** Injected clock (ms) for the cost controller (deterministic tests). */
  clock?: Clock;
  /** Backing spend store. Default a fresh {@link InMemoryBudgetStore}. */
  budgetStore?: BudgetStore;
  /** Resolve a `Pricing` for a provider/model when a usage entry has no cost. */
  pricing?: PricingResolver;
  /** Override the audit file (else `config.audit.file`; in-memory when neither). */
  auditFile?: string;
  /**
   * HMAC-SHA256 key chaining the audit log (see `audit/hashchain.ts`). Resolve
   * one via `resolveAuditKey` (SecretStore-backed, persists across process
   * restarts) when the chain must verify across CLI invocations. Defaults to a
   * fresh random key for this instance's lifetime only — fine for tests/an
   * in-process bundle, but NOT durable across a restart of a file-backed log.
   */
  auditKey?: Buffer | string;
}

/** The decision returned by {@link EnterpriseServices.authorize}, plus the subject. */
export interface EnterpriseAuthorization extends AuthorizationDecision {
  principal: Principal;
  action: string;
  resource: string;
}

/**
 * Constant-time token comparison so a wrong token cannot be discovered byte by
 * byte. Length is compared up front (unavoidable).
 */
function tokenEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export class EnterpriseServices {
  /** True only when `config.mode === "on"`. Every caller gates on this. */
  readonly enabled: boolean;
  readonly roleStore: RoleStore;
  readonly authorizer: Authorizer;
  readonly costController: CostController;
  readonly auditLog: AuditLog;
  readonly usageStore: UsageStore;
  readonly gatewaySet: GatewaySet;
  readonly defaultPrincipalId: string;

  private readonly principalsById = new Map<string, Principal>();
  private readonly tokenEntries: Array<{ token: string; id: string }> = [];
  private readonly defaultRole: string;

  constructor(config: EnterpriseWireConfig = {}, opts: EnterpriseServicesOptions = {}) {
    this.enabled = config.mode === "on";
    this.defaultRole = config.defaultRole ?? DEFAULT_ROLE_NAME;

    // ── RBAC ──────────────────────────────────────────────────────────────
    const roleData: {
      roles?: readonly import("../rbac/types.js").Role[];
      principals?: readonly Principal[];
      defaultRole?: string;
    } = { defaultRole: this.defaultRole };
    if (config.roles) roleData.roles = config.roles;
    if (config.principals) {
      roleData.principals = config.principals.map((p) => ({ id: p.id, roles: p.roles }));
    }
    this.roleStore = new RoleStore(roleData, { defaultRole: this.defaultRole });

    for (const p of config.principals ?? []) {
      this.principalsById.set(p.id, { id: p.id, roles: p.roles });
      if (p.token && p.token.length > 0) this.tokenEntries.push({ token: p.token, id: p.id });
    }

    // ── Policy + combined authorizer ──────────────────────────────────────
    const evaluator = new PolicyEvaluator(
      config.policies ? { rules: config.policies } : {},
    );
    this.authorizer = new Authorizer({ roleStore: this.roleStore, evaluator });

    // ── Cost controls ─────────────────────────────────────────────────────
    const ctrlOpts: ConstructorParameters<typeof CostController>[1] = {};
    if (opts.clock) ctrlOpts.clock = opts.clock;
    ctrlOpts.store = opts.budgetStore ?? new InMemoryBudgetStore();
    this.costController = new CostController(config.budgets ?? [], ctrlOpts);

    // ── Audit log ─────────────────────────────────────────────────────────
    const auditFile = opts.auditFile ?? config.audit?.file;
    const auditKey = opts.auditKey ?? randomBytes(32);
    this.auditLog = new AuditLog(auditFile ? { file: auditFile, key: auditKey } : { key: auditKey });

    // ── Usage analytics ───────────────────────────────────────────────────
    this.usageStore = new UsageStore(opts.pricing ? { pricing: opts.pricing } : {});

    // ── Private model gateways ────────────────────────────────────────────
    this.gatewaySet = {};
    if (config.gateways?.global) this.gatewaySet.global = config.gateways.global;
    if (config.gateways?.byProvider) this.gatewaySet.byProvider = config.gateways.byProvider;

    this.defaultPrincipalId =
      config.defaultPrincipal ?? config.principals?.[0]?.id ?? "cli";
  }

  // ── Principal resolution ───────────────────────────────────────────────────

  /**
   * Resolve a principal by id from the directory, falling back to a synthetic
   * principal that names no role (so the RoleStore applies `defaultRole`). Never
   * throws — an unknown id is a valid, minimally-privileged principal.
   */
  principalById(id: string): Principal {
    return this.principalsById.get(id) ?? { id, roles: [] };
  }

  /** Resolve a principal from a bearer token (constant-time), or undefined. */
  principalForToken(token: string): Principal | undefined {
    if (!token) return undefined;
    for (const entry of this.tokenEntries) {
      if (tokenEquals(entry.token, token)) return this.principalsById.get(entry.id);
    }
    return undefined;
  }

  /** The principal a CLI run is attributed to when none is supplied. */
  defaultPrincipal(): Principal {
    return this.principalById(this.defaultPrincipalId);
  }

  // ── Authorization ──────────────────────────────────────────────────────────

  /**
   * The combined RBAC + policy decision. Pure (no audit side-effect) — pass the
   * result to {@link audit} or use {@link authorizeAndAudit} to record it.
   */
  authorize(
    principal: Principal,
    action: string,
    resource: string,
    context?: AuthorizationContext,
  ): EnterpriseAuthorization {
    const decision = this.authorizer.authorize({
      principal,
      action,
      resource,
      ...(context ? { context } : {}),
    });
    return { ...decision, principal, action, resource };
  }

  /**
   * {@link authorize} + a committed audit record (`policy.decision` when policy
   * decided, else `rbac.decision`). Returns the decision. Always safe to call.
   */
  authorizeAndAudit(
    principal: Principal,
    action: string,
    resource: string,
    context?: AuthorizationContext,
    extra?: { sessionId?: string; details?: Record<string, unknown> },
  ): EnterpriseAuthorization {
    const result = this.authorize(principal, action, resource, context);
    const input: AuditInput = {
      actor: principal.id,
      action: result.source === "policy" ? "policy.decision" : "rbac.decision",
      resource,
      decision: result.allowed ? "allow" : "deny",
      details: { action, reason: result.reason, ...(extra?.details ?? {}) },
    };
    const role = principal.roles[0];
    if (role !== undefined) input.role = role;
    if (extra?.sessionId !== undefined) input.sessionId = extra.sessionId;
    this.auditLog.append(input);
    return result;
  }

  // ── Cost enforcement ───────────────────────────────────────────────────────

  /**
   * Pre-run budget gate: allow | warn | deny | downgrade for a projected cost.
   * The caller (dispatch pre-run check / router) applies the verdict. A `deny`
   * or `downgrade` is audited; `allow`/`warn` are not (to keep the log signal
   * high) unless `auditAll` is set.
   */
  enforceBudget(
    principal: CostPrincipal,
    projectedUsd: number,
    opts: { auditAll?: boolean; sessionId?: string } = {},
  ): EnforceResult {
    const result = this.costController.enforce(principal, projectedUsd);
    if (opts.auditAll || result.decision === "deny" || result.decision === "downgrade") {
      const input: AuditInput = {
        actor: principal.principal ?? "unknown",
        action: "policy.decision",
        resource: `budget:${result.budgetId ?? "none"}`,
        decision: result.decision === "deny" ? "deny" : result.decision === "allow" ? "allow" : "info",
        details: {
          kind: "budget",
          decision: result.decision,
          projectedUsd,
          spentUsd: result.spentUsd,
          limitUsd: result.limitUsd,
          reason: result.reason,
        },
      };
      if (principal.role !== undefined) input.role = principal.role;
      if (opts.sessionId !== undefined) input.sessionId = opts.sessionId;
      this.auditLog.append(input);
    }
    return result;
  }

  /**
   * Post-run accrual: price the run's usage (via `pricing`, honoring any
   * reported/embedded cost), record it against every governing budget, AND feed
   * the usage analytics store. Returns the computed cost.
   */
  recordRun(
    principal: CostPrincipal,
    usage: Usage,
    pricing: Pricing,
    meta: { provider: string; model: string; ts?: number },
  ): number {
    const cost = this.costController.recordUsage(principal, usage, pricing);
    const entry: import("../analytics/types.js").UsageEntry = {
      ts: meta.ts ?? Date.now(),
      principal: principal.principal ?? "unknown",
      provider: meta.provider,
      model: meta.model,
      usage,
      costUsd: cost,
    };
    if (principal.role !== undefined) entry.role = principal.role;
    this.usageStore.record(entry);
    return cost;
  }

  // ── Audit ──────────────────────────────────────────────────────────────────

  /** Commit an arbitrary audit record (redacted + hash-chained). */
  audit(input: AuditInput): AuditRecord {
    return this.auditLog.append(input);
  }

  // ── Hook + interceptor adapters ─────────────────────────────────────────────

  /**
   * A `pre-tool` HookHandler that denies a tool call the authorizer rejects and
   * feeds every decision to the audit log. `resolvePrincipal` maps a payload's
   * `sessionId` to the acting principal (return undefined to observe only).
   */
  toolAuthorizationHook(
    resolvePrincipal: (sessionId: string | undefined) => Principal | undefined,
    resolveContext?: (payload: {
      toolName: string;
      permission: string | undefined;
    }) => AuthorizationContext | undefined,
  ): HookHandler<"pre-tool"> {
    return createAuthorizationHook({
      authorizer: this.authorizer,
      resolvePrincipal,
      ...(resolveContext
        ? { resolveContext: (p) => resolveContext({ toolName: p.toolName, permission: p.permission }) }
        : {}),
      onDecision: (info) => {
        const input: AuditInput = {
          actor: info.principal.id,
          action: "tool.approval",
          resource: info.resource,
          decision: info.allowed ? "allow" : "deny",
          details: { action: info.action, reason: info.reason },
        };
        const role = info.principal.roles[0];
        if (role !== undefined) input.role = role;
        this.auditLog.append(input);
      },
    });
  }
}

/**
 * Build the enterprise services bundle from a validated config section. Always
 * succeeds; when `mode !== "on"` the returned bundle is inert (`enabled:false`).
 */
export function buildEnterpriseServices(
  config: EnterpriseWireConfig = {},
  opts: EnterpriseServicesOptions = {},
): EnterpriseServices {
  return new EnterpriseServices(config, opts);
}
