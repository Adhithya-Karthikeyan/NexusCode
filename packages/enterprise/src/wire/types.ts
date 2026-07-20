/**
 * Wiring config for the enterprise subsystem (system-spec §25). The harness
 * (CLI / SDK / REST daemon) turns its validated `config.enterprise` section into
 * a live {@link EnterpriseServices} bundle through {@link buildEnterpriseServices}.
 *
 * This shape is defined STRUCTURALLY here (not imported from `@nexuscode/config`)
 * so the enterprise package never build-couples to the config cascade — exactly
 * as `cost/integrate.ts` mirrors the hook payloads and `policy/hook.ts` mirrors
 * the `HookBus` verdict. The zod schema in `@nexuscode/config` produces a value
 * assignable to this interface.
 */

import type { Role, Principal } from "../rbac/types.js";
import type { PolicyRule } from "../policy/types.js";
import type { Budget } from "../cost/types.js";
import type { GatewayConfig } from "../gateway/types.js";

/** On/off master switch for enterprise enforcement. */
export type EnterpriseMode = "off" | "on";

/** A principal directory entry that may also carry a bearer token (REST). */
export interface EnterprisePrincipal extends Principal {
  /**
   * Optional bearer token that authenticates this principal to the REST daemon.
   * Never logged; used only for constant-time token→principal resolution. Absent
   * for principals that only act through the CLI (resolved by id).
   */
  token?: string;
}

/** Audit-log persistence settings. */
export interface EnterpriseAuditConfig {
  /** NDJSON file the tamper-evident audit chain is appended to. In-memory when omitted. */
  file?: string;
}

/** Private-model-gateway settings: a global default plus per-provider overrides. */
export interface EnterpriseGatewaysConfig {
  global?: GatewayConfig;
  byProvider?: Record<string, GatewayConfig>;
}

/**
 * The `enterprise` config section. Every field is optional so a config with
 * `mode:"off"` (or no section at all) leaves single-user behavior untouched.
 */
export interface EnterpriseWireConfig {
  /** Master switch. `"off"` (default) ⇒ no enforcement anywhere. */
  mode?: EnterpriseMode;
  /** Role assigned to a principal that names no known role. Default `"default"`. */
  defaultRole?: string;
  /** Custom roles merged over the four built-ins (admin/developer/viewer/default). */
  roles?: readonly Role[];
  /** Principal directory (id → roles, optional bearer token). */
  principals?: readonly EnterprisePrincipal[];
  /** Declarative deny-overrides policy rules layered on top of RBAC. */
  policies?: readonly PolicyRule[];
  /** Spend budgets per principal/role/org. */
  budgets?: readonly Budget[];
  /** Private model gateways (corporate proxy) applied at registry construction. */
  gateways?: EnterpriseGatewaysConfig;
  /** Audit-log persistence. */
  audit?: EnterpriseAuditConfig;
  /**
   * The principal a CLI run is attributed to when none is supplied on the
   * command line / env. Defaults to the first configured principal, else a
   * synthetic `"cli"` principal (which resolves to `defaultRole`).
   */
  defaultPrincipal?: string;
}
