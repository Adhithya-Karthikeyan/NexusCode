/**
 * @nexuscode/enterprise — wiring barrel (system-spec §25). Turns a validated
 * `config.enterprise` section into one live {@link EnterpriseServices} bundle
 * the CLI / SDK / REST daemon plug into the existing PermissionGate / hook bus /
 * router / server-auth seams.
 */

export {
  EnterpriseServices,
  buildEnterpriseServices,
  type EnterpriseServicesOptions,
  type EnterpriseAuthorization,
} from "./services.js";
export type {
  EnterpriseWireConfig,
  EnterpriseMode,
  EnterprisePrincipal,
  EnterpriseAuditConfig,
  EnterpriseGatewaysConfig,
} from "./types.js";
