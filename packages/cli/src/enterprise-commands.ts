/**
 * Enterprise CLI surface (system-spec §25): `nexus rbac | policy | usage | audit
 * | budget`. Each is a thin, offline, read-mostly view over the live
 * {@link EnterpriseServices} bundle built from `config.enterprise` — inspect
 * roles/grants and run a `check`, list/test policies, report usage + cost from
 * the run history, query + VERIFY the tamper-evident audit chain, and show/set
 * budgets. `budget set` is the one mutation: it writes to the user config layer.
 *
 * `usage` is deliberately an ORG-WIDE report: the run history stores no acting
 * principal, so per-person figures cannot be derived from it and are never
 * invented — see {@link UNATTRIBUTED_NOTE} and the `manage` gate on
 * {@link USAGE_RESOURCE}.
 */

import { loadConfig, nexusPaths, type NexusConfig } from "@nexuscode/config";
import {
  toCsv,
  UsageStore,
  UNATTRIBUTED_PRINCIPAL,
  type UsageQuery,
  type AuditQuery,
  type AuditAction,
  type AuditDecision,
  type TimeWindow as UsageWindow,
} from "@nexuscode/enterprise";
import type { ParsedArgs } from "./args.js";
import { buildEnterprise, resolvePrincipal, costPrincipalFor } from "./enterprise.js";
import { userConfigDir, readUserConfig, writeUserConfig } from "./config-io.js";
import { historyList } from "./history.js";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIo: Io = {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
};

async function loadEffectiveConfig(): Promise<NexusConfig> {
  const { config } = await loadConfig({ userConfigDir: userConfigDir() });
  return config;
}

function isJson(args: ParsedArgs): boolean {
  return args.flags.get("output") === "json";
}

// ── rbac ────────────────────────────────────────────────────────────────────

export async function cmdRbac(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const config = await loadEffectiveConfig();
  const services = await buildEnterprise(config);
  const e = config.enterprise;

  if (sub === "list" || sub === "roles") {
    const builtins = ["admin", "developer", "viewer", "default"];
    if (isJson(args)) {
      io.out(
        `${JSON.stringify({
          mode: e.mode,
          builtinRoles: builtins,
          roles: e.roles,
          principals: e.principals.map((p) => ({ id: p.id, roles: p.roles })),
          defaultRole: e.defaultRole,
        })}\n`,
      );
      return 0;
    }
    io.out(`rbac — mode=${e.mode}, defaultRole=${e.defaultRole}\n`);
    io.out(`built-in roles: ${builtins.join(", ")}\n`);
    io.out(`custom roles (${e.roles.length}):\n`);
    for (const r of e.roles) {
      io.out(`  ${r.name}${r.inherits && r.inherits.length ? ` (inherits ${r.inherits.join(", ")})` : ""}\n`);
      for (const g of r.grants) io.out(`      ${g.actions.join(",")} on ${g.resources.join(", ")}\n`);
    }
    io.out(`principals (${e.principals.length}):\n`);
    for (const p of e.principals) io.out(`  ${p.id} → ${p.roles.join(", ") || "(default)"}\n`);
    return 0;
  }

  if (sub === "check") {
    const action = args.flags.get("action");
    const resource = args.flags.get("resource");
    if (!action || !resource) {
      io.err("nexus rbac check --principal <id> --action <a> --resource <type:id>\n");
      return 2;
    }
    const principal = resolvePrincipal(services, { id: args.flags.get("principal") });
    const decision = services.authorize(principal, action, resource);
    if (isJson(args)) {
      io.out(
        `${JSON.stringify({
          principal: principal.id,
          roles: principal.roles,
          action,
          resource,
          allowed: decision.allowed,
          source: decision.source,
          reason: decision.reason,
        })}\n`,
      );
    } else {
      io.out(
        `${decision.allowed ? "ALLOW" : "DENY"} — ${principal.id} [${principal.roles.join(",") || "default"}] ` +
          `${action} on ${resource}\n  source=${decision.source}: ${decision.reason}\n`,
      );
    }
    return decision.allowed ? 0 : 1;
  }

  io.err(`nexus rbac: unknown subcommand "${sub}" (use: list | check)\n`);
  return 2;
}

// ── policy ──────────────────────────────────────────────────────────────────

export async function cmdPolicy(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "list";
  const config = await loadEffectiveConfig();
  const services = await buildEnterprise(config);
  const e = config.enterprise;

  if (sub === "list") {
    if (isJson(args)) {
      io.out(`${JSON.stringify({ mode: e.mode, policies: e.policies })}\n`);
      return 0;
    }
    io.out(`policy — mode=${e.mode}, ${e.policies.length} rule(s) (deny-overrides, fail-closed)\n`);
    for (const r of e.policies) {
      const subj = r.subjects
        ? `[roles=${(r.subjects.roles ?? []).join(",")} principals=${(r.subjects.principals ?? []).join(",")}]`
        : "[any]";
      io.out(
        `  ${r.id ?? "(anon)"}: ${r.effect.toUpperCase()} ${subj} ` +
          `actions=${(r.actions ?? ["*"]).join(",")} resources=${(r.resources ?? ["*"]).join(",")}` +
          `${r.conditions ? ` when ${JSON.stringify(r.conditions)}` : ""}` +
          `${r.description ? ` — ${r.description}` : ""}\n`,
      );
    }
    return 0;
  }

  if (sub === "test") {
    const action = args.flags.get("action");
    const resource = args.flags.get("resource");
    if (!action || !resource) {
      io.err("nexus policy test --principal <id> --action <a> --resource <type:id> [--cost <usd>]\n");
      return 2;
    }
    const principal = resolvePrincipal(services, { id: args.flags.get("principal") });
    const costRaw = args.flags.get("cost");
    const context = costRaw !== undefined ? { costUsd: Number(costRaw) } : undefined;
    const decision = services.authorize(principal, action, resource, context);
    if (isJson(args)) {
      io.out(
        `${JSON.stringify({
          principal: principal.id,
          roles: principal.roles,
          action,
          resource,
          costUsd: context?.costUsd,
          allowed: decision.allowed,
          source: decision.source,
          reason: decision.reason,
          matchedRule: decision.matchedRule ?? null,
        })}\n`,
      );
    } else {
      io.out(
        `${decision.allowed ? "ALLOW" : "DENY"} — ${principal.id} ${action} on ${resource}` +
          `${context ? ` (cost $${context.costUsd})` : ""}\n  source=${decision.source}: ${decision.reason}\n` +
          `${decision.matchedRule ? `  matched rule: ${decision.matchedRule.id ?? "(anon)"} [${decision.matchedRule.effect}]\n` : ""}`,
      );
    }
    return decision.allowed ? 0 : 1;
  }

  io.err(`nexus policy: unknown subcommand "${sub}" (use: list | test)\n`);
  return 2;
}

// ── usage ───────────────────────────────────────────────────────────────────

/**
 * The resource `nexus usage` authorizes against. It reports ORG-WIDE spend, so
 * it is gated on the administrative `manage` verb — which `admin` holds and
 * `developer` / `viewer` / `default` deliberately do not (see builtin-roles).
 */
export const USAGE_RESOURCE = "command:usage";

/** Stated on every `usage` report so the figures are never read as one user's. */
export const UNATTRIBUTED_NOTE =
  "run history records no per-principal attribution — these totals cover every user of this history database";

export async function cmdUsage(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const config = await loadEffectiveConfig();
  const services = await buildEnterprise(config);
  const caller = resolvePrincipal(services, { id: args.flags.get("principal") });

  // The run history has NO principal column: nothing in it says who made a run.
  // So every figure this command can produce is an ORG-WIDE total covering all
  // users, and it is reported as such — the previous behavior, re-recording the
  // whole history under whoever happened to be calling, invented attribution and
  // handed any principal the organization's total spend.
  //
  // Because the view is unavoidably org-wide, enterprise mode gates it on
  // `manage` over `command:usage`. Off-mode (single user, no org) is untouched:
  // `services.enabled` is false and there is nothing to leak.
  //
  // Scope of this gate: CLI identity is SELF-ASSERTED (`--principal` /
  // `$NEXUS_PRINCIPAL` are unauthenticated — see `resolvePrincipal`), so this
  // is role hygiene, not an access-control boundary against a local user who
  // can simply claim another id. It is checked BEFORE the history is read, so
  // no figure reaches any output branch on the denied path.
  if (services.enabled) {
    const decision = services.authorize(caller, "manage", USAGE_RESOURCE);
    if (!decision.allowed) {
      const detail =
        `${caller.id} [${caller.roles.join(",") || "default"}] may not read org-wide usage ` +
        `(manage on ${USAGE_RESOURCE}) — ${decision.source}: ${decision.reason}`;
      // Machine consumers must not get prose on stderr where they expect JSON.
      if (isJson(args) || args.flags.get("format") === "json") {
        io.err(`${JSON.stringify({ error: "forbidden", principal: caller.id, detail })}\n`);
      } else {
        io.err(`DENY — ${detail}\n  note: ${UNATTRIBUTED_NOTE}.\n`);
      }
      return 1;
    }
  }

  const dbPath = config.history.dbPath ?? nexusPaths().historyDb;
  const rows = await historyList(dbPath, 1_000_000);
  const store = new UsageStore();
  for (const r of rows) {
    // Deliberately NOT `caller.id` — see UNATTRIBUTED_PRINCIPAL.
    store.recordRunSummary(r, { principal: UNATTRIBUTED_PRINCIPAL });
  }

  const window = (args.flags.get("window") as UsageWindow) ?? "day";
  const query: UsageQuery = { window };
  const provider = args.flags.get("provider");
  const model = args.flags.get("model");
  const from = args.flags.get("from");
  const to = args.flags.get("to");
  if (provider) query.provider = provider;
  if (model) query.model = model;
  if (from) query.from = Number(from);
  if (to) query.to = Number(to);
  const report = store.report(query);

  const format = args.flags.get("format");
  if (format === "csv") {
    io.out(toCsv(report));
    return 0;
  }
  if (isJson(args) || format === "json") {
    // Machine consumers get the scope stated explicitly, so nothing downstream
    // can mistake these totals for one person's spend.
    const envelope = {
      scope: "org-wide",
      attribution: "none",
      note: UNATTRIBUTED_NOTE,
      ...report,
    };
    io.out(`${JSON.stringify(envelope, null, isJson(args) ? 0 : 2)}\n`);
    return 0;
  }

  const t = report.totals;
  io.out(`usage — window=${window}, ${t.count} run(s), ORG-WIDE across all users\n`);
  io.out(`  ${UNATTRIBUTED_NOTE}\n`);
  io.out(`  tokens: in=${t.inputTokens} out=${t.outputTokens} cost=$${t.costUsd.toFixed(6)}\n`);
  io.out(`by provider:\n`);
  for (const [p, tot] of Object.entries(report.byProvider)) {
    io.out(`  ${p}: ${tot.count} run(s), $${tot.costUsd.toFixed(6)}\n`);
  }
  io.out(`by model:\n`);
  for (const [m, tot] of Object.entries(report.byModel)) {
    io.out(`  ${m}: ${tot.count} run(s), in=${tot.inputTokens} out=${tot.outputTokens}, $${tot.costUsd.toFixed(6)}\n`);
  }
  return 0;
}

// ── audit ───────────────────────────────────────────────────────────────────

export async function cmdAudit(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const config = await loadEffectiveConfig();
  const services = await buildEnterprise(config);

  if (args.bools.has("verify")) {
    // Never let a read/parse failure surface as a stack trace: `--verify` is the
    // tool an operator reaches for when the log is suspect, so an unreadable
    // chain must be REPORTED as a failure, not crash the reporter.
    let result: ReturnType<typeof services.auditLog.verifyFile>;
    try {
      result = services.auditLog.verifyFile();
    } catch (err) {
      io.err(`audit chain UNVERIFIABLE — ${(err as Error).message}\n`);
      return 1;
    }
    if (isJson(args)) {
      io.out(`${JSON.stringify(result)}\n`);
    } else if (result.ok) {
      io.out(`audit chain OK — ${result.count} record(s), intact (tamper-evident hash chain verified)\n`);
    } else {
      io.err(`audit chain TAMPERED — ${result.tampered.length} finding(s):\n`);
      for (const t of result.tampered) io.err(`  seq ${t.seq}: ${t.reason} — ${t.detail}\n`);
    }
    return result.ok ? 0 : 1;
  }

  const query: AuditQuery = {};
  const actor = args.flags.get("actor");
  const actionF = args.flags.get("action");
  const decisionF = args.flags.get("decision");
  const from = args.flags.get("from");
  const to = args.flags.get("to");
  if (actor) query.actor = actor;
  if (actionF) query.action = actionF as AuditAction;
  if (decisionF) query.decision = decisionF as AuditDecision;
  if (from) query.from = Number(from);
  if (to) query.to = Number(to);
  const limitRaw = args.flags.get("limit");
  const limit = limitRaw ? Math.max(1, Number(limitRaw)) : 50;
  const records = services.auditLog.query(query).slice(-limit);

  if (isJson(args)) {
    io.out(`${JSON.stringify({ count: records.length, records })}\n`);
    return 0;
  }
  io.out(`audit — ${records.length} record(s)${query.actor ? ` for ${query.actor}` : ""}\n`);
  for (const r of records) {
    io.out(
      `  #${r.seq} ${new Date(r.ts).toISOString()} ${r.actor}${r.role ? `[${r.role}]` : ""} ` +
        `${r.action} ${r.decision.toUpperCase()}${r.resource ? ` ${r.resource}` : ""}\n`,
    );
  }
  return 0;
}

// ── budget ──────────────────────────────────────────────────────────────────

export async function cmdBudget(args: ParsedArgs, io: Io = defaultIo): Promise<number> {
  const sub = args.positionals[0] ?? "show";
  const config = await loadEffectiveConfig();

  if (sub === "show" || sub === "list") {
    const services = await buildEnterprise(config);
    const principal = resolvePrincipal(services, { id: args.flags.get("principal") });
    // Spend reflects the persisted FileBudgetStore the runs accrue into, so
    // `show` and enforcement read the same accrual.
    const statuses = services.costController.remaining(costPrincipalFor(principal));
    if (isJson(args)) {
      io.out(`${JSON.stringify({ budgets: config.enterprise.budgets, status: statuses })}\n`);
      return 0;
    }
    io.out(`budgets — ${config.enterprise.budgets.length} configured (mode=${config.enterprise.mode})\n`);
    for (const b of config.enterprise.budgets) {
      const st = statuses.find((s) => s.budgetId === b.id);
      io.out(
        `  ${b.id} [${b.scope}:${b.key}] $${b.limitUsd}/${b.window}` +
          `${b.onExceed ? ` on-exceed=${b.onExceed}${b.downgradeTo ? `→${b.downgradeTo}` : ""}` : ""}` +
          `${st ? ` — spent $${st.spentUsd.toFixed(6)}, remaining $${st.remainingUsd.toFixed(6)}${st.warn ? " ⚠" : ""}` : ""}\n`,
      );
    }
    return 0;
  }

  if (sub === "set") {
    const id = args.flags.get("id");
    const scope = args.flags.get("scope");
    const key = args.flags.get("key");
    const limitRaw = args.flags.get("limit");
    const window = args.flags.get("window");
    if (!id || !scope || !key || limitRaw === undefined || !window) {
      io.err("nexus budget set --id <id> --scope <principal|role|org> --key <k> --limit <usd> --window <run|day|month> [--on-exceed deny|downgrade] [--downgrade-to <model>]\n");
      return 2;
    }
    const budget: Record<string, unknown> = {
      id,
      scope,
      key,
      limitUsd: Number(limitRaw),
      window,
    };
    if (args.flags.get("on-exceed")) budget.onExceed = args.flags.get("on-exceed");
    if (args.flags.get("downgrade-to")) budget.downgradeTo = args.flags.get("downgrade-to");
    if (args.flags.get("warn-threshold")) budget.warnThreshold = Number(args.flags.get("warn-threshold"));

    // Both the read and the write refuse when the config file in force cannot
    // be updated here (a YAML config shadowing what the CLI can write) — report
    // that on stderr as a command failure rather than letting it escape.
    let raw: Record<string, unknown>;
    try {
      raw = readUserConfig() as Record<string, unknown>;
    } catch (err) {
      io.err(`nexus budget set: ${(err as Error).message}\n`);
      return 1;
    }
    const ent = (raw.enterprise as Record<string, unknown>) ?? {};
    const budgets = Array.isArray(ent.budgets) ? (ent.budgets as Record<string, unknown>[]) : [];
    const next = budgets.filter((b) => b.id !== id);
    next.push(budget);
    ent.budgets = next;
    raw.enterprise = ent;
    // Validate the whole config before persisting (fail loudly on a bad budget).
    try {
      const { NexusConfig } = await import("@nexuscode/config");
      NexusConfig.parse(raw);
    } catch (err) {
      io.err(`nexus budget set: invalid config — ${(err as Error).message}\n`);
      return 1;
    }
    // writeUserConfig targets the config file the loader actually reads, and
    // refuses rather than write somewhere shadowed — report that as a failure
    // instead of printing a success the effective config would not reflect.
    let file: string;
    try {
      file = writeUserConfig(raw);
    } catch (err) {
      io.err(`nexus budget set: ${(err as Error).message}\n`);
      return 1;
    }
    io.out(`budget "${id}" set: $${Number(limitRaw)}/${window} for ${scope}:${key} → ${file}\n`);
    return 0;
  }

  io.err(`nexus budget: unknown subcommand "${sub}" (use: show | set)\n`);
  return 2;
}
