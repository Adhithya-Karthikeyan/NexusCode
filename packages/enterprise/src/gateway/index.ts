/** Private model gateways — public surface (system-spec §25). */

export type {
  GatewayConfig,
  GatewaySet,
  GatewayableProviderConfig,
} from "./types.js";
export { GatewayEgressError } from "./types.js";
export {
  applyGateway,
  applyGatewaySet,
  resolveGateway,
  isEgressAllowed,
  hostOf,
} from "./gateway.js";
