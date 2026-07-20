/**
 * @nexuscode/enterprise — RBAC barrel (system-spec §25). A fail-closed,
 * allow-only permission model over provider/model/tool/command/agent-role
 * resources, backed by config/file roles + built-ins.
 */

export {
  RESOURCE_TYPES,
  type Action,
  type Grant,
  type Principal,
  type RbacDecision,
  type ResourceType,
  type Role,
  type RoleStoreData,
} from "./types.js";

export {
  BUILTIN_ROLES,
  DEFAULT_ROLE_NAME,
  ROLE_ADMIN,
  ROLE_DEFAULT,
  ROLE_DEVELOPER,
  ROLE_VIEWER,
} from "./builtin-roles.js";

export { matchesAny, matchesPattern, patternToRegExp } from "./match.js";

export {
  RoleStore,
  parseResource,
  type RoleStoreOptions,
} from "./role-store.js";
