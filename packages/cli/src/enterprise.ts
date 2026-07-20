/**
 * CLI-side enterprise wiring (system-spec §25). Turns the validated
 * `config.enterprise` section into one live {@link EnterpriseServices} bundle and
 * exposes the glue the headless commands use to enforce it AROUND the existing
 * engine — the PermissionGate / native tool loop, the hook bus, the router
 * pre-run check, and the REST server auth. Nothing here re-implements the
 * engine; it plugs decisions into seams that already exist.
 *
 * Everything is OFF by default: when `config.enterprise.mode !== "on"` the
 * services bundle reports `enabled:false` and every helper below is a no-op, so
 * single-user behavior is byte-for-byte unchanged.
 */

import { join } from "node:path";
import { createSecretStore, nexusPaths, pricingTable, type NexusConfig, type SecretStore } from "@nexuscode/config";
import type { Pricing, Usage } from "@nexuscode/shared";
import {
  buildEnterpriseServices,
  actionForToolPermission,
  resolveAuditKey,
  auditKeyRef,
  EnterpriseServices,
  FileBudgetStore,
  type EnterpriseWireConfig,
  type Principal,
  type CostPrincipal,
} from "@nexuscode/enterprise";
import { computeCost } from "@nexuscode/shared";
import type { ServerEnterprise } from "@nexuscode/server";
import type { ToolInterceptor } from "@nexuscode/core";
import type { ToolRegistry } from "@nexuscode/tools";

/** Default on-disk audit file when the config names none. */
export function defaultAuditFile(env: NodeJS.ProcessEnv = process.env): string {
  const dataDir = env.NEXUS_DATA_DIR ?? nexusPaths().data;
  return join(dataDir, "audit.ndjson");
}

/**
 * Build the enterprise services bundle from the effective config. A pricing
 * resolver drawn from `config.pricing` lets budgets/analytics cost a run with
 * the SAME frozen `computeCost` seam the accounting layer uses. When no audit
 * file is configured, spend/decisions still record to a default data-dir file so
 * the tamper-evident chain survives across CLI invocations.
 *
 * When enterprise mode is "on", the audit chain's HMAC key is resolved (and,
 * on first use, generated + persisted) through the `SecretStore` so the SAME
 * key — not co-located with the audit file — is used across CLI invocations
 * and the chain built by one run verifies in the next. Off-mode never touches
 * the SecretStore (the audit log stays unused), so a missing/unconfigured
 * secret backend never breaks ordinary (non-enterprise) CLI usage.
 */
export async function buildEnterprise(
  config: NexusConfig,
  secrets?: SecretStore,
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<EnterpriseServices> {
  const env = opts.env ?? process.env;
  const table = pricingTable(config);
  const resolver = (provider: string, model: string): Pricing | undefined =>
    table[model] ?? table[`${provider}/${model}`] ?? table[provider];
  const wire = config.enterprise as EnterpriseWireConfig;
  const auditFile = wire.audit?.file ?? defaultAuditFile(env);
  // Persist budget spend so day/month/run windows accrue across CLI invocations.
  const dataDir = env.NEXUS_DATA_DIR ?? nexusPaths().data;
  const budgetStore = new FileBudgetStore(join(dataDir, "budget-spend.json"));
  let auditKey: Buffer | undefined;
  if (wire.mode === "on") {
    const store = secrets ?? createSecretStore();
    auditKey = await resolveAuditKey(store, auditKeyRef(auditFile));
  }
  return buildEnterpriseServices(wire, {
    pricing: resolver,
    auditFile,
    budgetStore,
    ...(auditKey ? { auditKey } : {}),
  });
}

/**
 * A deterministic pre-run cost estimate for the budget gate: input tokens are
 * approximated from the prompt length (~4 chars/token), output tokens from a
 * nominal completion size, priced via `config.pricing` (0 when unpriced). The
 * router owns the real number post-run; this is only the pre-run projection the
 * cost gate tests against.
 */
export function estimateRunUsd(
  config: NexusConfig,
  provider: string,
  model: string,
  promptChars: number,
  nominalOutputTokens = 512,
): number {
  const table = pricingTable(config);
  const pricing = table[model] ?? table[`${provider}/${model}`] ?? table[provider];
  if (!pricing) return 0;
  const inputTokens = Math.ceil(promptChars / 4);
  return computeCost({ inputTokens, outputTokens: nominalOutputTokens }, pricing);
}

/**
 * Resolve the principal a CLI run is attributed to: `--principal <id>` wins,
 * then `$NEXUS_PRINCIPAL`, then the configured default principal (which resolves
 * to `defaultRole` when unknown). Returns the fail-closed default even off-mode
 * so callers never crash.
 */
export function resolvePrincipal(
  services: EnterpriseServices,
  opts: { id?: string | undefined; env?: NodeJS.ProcessEnv } = {},
): Principal {
  const env = opts.env ?? process.env;
  const id = opts.id ?? env.NEXUS_PRINCIPAL;
  if (id && id.length > 0) return services.principalById(id);
  return services.defaultPrincipal();
}

/** The cost principal (principal/role/org + runId) for a resolved RBAC principal. */
export function costPrincipalFor(principal: Principal, runId?: string): CostPrincipal {
  const cp: CostPrincipal = { principal: principal.id };
  const role = principal.roles[0];
  if (role !== undefined) cp.role = role;
  if (runId !== undefined) cp.runId = runId;
  return cp;
}

/**
 * A {@link ToolInterceptor} that authorizes every native-tool-loop call for a
 * fixed principal through the combined RBAC + policy authorizer, records the
 * decision to the audit log, and VETOES a denied call (its reason becomes the
 * tool's error result). The tool's permission class (read/write/exec/network) is
 * resolved from the registry and mapped to an RBAC verb. Fail-closed: an unknown
 * tool maps to the `use` verb (denied unless explicitly granted).
 *
 * Composes AFTER any existing hooks interceptor (see {@link composeInterceptors})
 * so command hooks and enterprise authorization both run.
 */
export function enterpriseToolInterceptor(
  services: EnterpriseServices,
  principal: Principal,
  toolRegistry: ToolRegistry,
  sessionId?: string,
): ToolInterceptor {
  return {
    preTool(req) {
      const permission = toolRegistry.has(req.name) ? toolRegistry.get(req.name).permission : undefined;
      const action = actionForToolPermission(permission);
      const resource = `tool:${req.name}`;
      const decision = services.authorizeAndAudit(
        principal,
        action,
        resource,
        undefined,
        { ...(sessionId ? { sessionId } : {}), details: { via: "agent-tool-loop" } },
      );
      if (!decision.allowed) return { block: true, reason: decision.reason };
      return;
    },
  };
}

/**
 * Chain two optional interceptors into one: `first` runs before `second` on
 * `preTool` (a `first` veto short-circuits `second`), and both run on `postTool`.
 * Returns undefined when neither is present.
 */
export function composeInterceptors(
  first: ToolInterceptor | undefined,
  second: ToolInterceptor | undefined,
): ToolInterceptor | undefined {
  if (!first) return second;
  if (!second) return first;
  return {
    async preTool(req) {
      if (first.preTool) {
        const v = await first.preTool(req);
        if (v && (v.block || v.input !== undefined)) return v;
      }
      if (second.preTool) return second.preTool(req);
      return;
    },
    async postTool(res) {
      if (first.postTool) await first.postTool(res);
      if (second.postTool) await second.postTool(res);
    },
  };
}

/**
 * Adapt the services bundle into the REST server's structural
 * {@link ServerEnterprise} seam: token→principal resolution, per-request RBAC,
 * and an audit sink. Only meaningful when `services.enabled` — callers pass it
 * to `createNexusServer` only under enterprise mode.
 */
export function toServerEnterprise(services: EnterpriseServices): ServerEnterprise {
  return {
    principalForToken: (token) => services.principalForToken(token),
    authorize: (principal, action, resource) =>
      services.authorize({ id: principal.id, roles: principal.roles }, action, resource),
    audit: (info) => {
      const input: import("@nexuscode/enterprise").AuditInput = {
        actor: info.principal.id,
        action: "auth.token",
        resource: info.resource,
        decision: info.allowed ? "allow" : "deny",
        details: { httpAction: info.action, method: info.method, path: info.path, reason: info.reason },
      };
      const role = info.principal.roles[0];
      if (role !== undefined) input.role = role;
      services.audit(input);
    },
  };
}

/**
 * Record a completed run's usage against budgets + analytics and audit the run
 * end. Prices the usage with the resolved `pricing`. No-op when off-mode.
 */
export function recordRunSpend(
  services: EnterpriseServices,
  principal: Principal,
  usage: Usage,
  pricing: Pricing,
  meta: { provider: string; model: string; runId?: string; sessionId?: string },
): number {
  if (!services.enabled) return 0;
  const cost = services.recordRun(costPrincipalFor(principal, meta.runId), usage, pricing, {
    provider: meta.provider,
    model: meta.model,
  });
  const input: import("@nexuscode/enterprise").AuditInput = {
    actor: principal.id,
    action: "run.end",
    resource: `run:${meta.runId ?? "unknown"}`,
    decision: "success",
    details: { provider: meta.provider, model: meta.model, costUsd: cost },
  };
  const role = principal.roles[0];
  if (role !== undefined) input.role = role;
  if (meta.sessionId !== undefined) input.sessionId = meta.sessionId;
  services.audit(input);
  return cost;
}

/** One-line-per-pillar enterprise status for `nexus doctor`. */
export function enterpriseStatus(config: NexusConfig): {
  enabled: boolean;
  lines: string[];
} {
  const e = config.enterprise;
  const enabled = e.mode === "on";
  const gwCount =
    (e.gateways?.global ? 1 : 0) + (e.gateways?.byProvider ? Object.keys(e.gateways.byProvider).length : 0);
  const lines = [
    `  [${enabled ? "on " : "off"}] enterprise — mode=${e.mode}`,
    `           rbac    — ${e.roles.length} custom role(s) + 4 built-in, ${e.principals.length} principal(s), defaultRole=${e.defaultRole}`,
    `           policy  — ${e.policies.length} rule(s) (deny-overrides, fail-closed)`,
    `           budgets — ${e.budgets.length} budget(s)`,
    `           gateway — ${gwCount} gateway(s) configured`,
    `           audit   — ${e.audit?.file ?? defaultAuditFile()} (append-only, hash-chained)`,
  ];
  return { enabled, lines };
}
