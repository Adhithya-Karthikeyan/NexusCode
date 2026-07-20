/**
 * The four built-in roles (system-spec §25). These are the fail-closed baseline
 * every {@link RoleStore} starts from; custom roles merge over them by name.
 *
 *   admin      — every action on every resource (unrestricted operator).
 *   developer  — read/write/execute/use across all resource namespaces, but NO
 *                `manage` verb and no wildcard resource, so a developer can use
 *                the system fully yet cannot administer RBAC/policy itself.
 *   viewer     — read-only across all resources; every mutating/using action
 *                is denied.
 *   default    — the minimal role for an unassigned principal: read the catalog
 *                (providers + models) and nothing else.
 */

import type { Role } from "./types.js";

export const ROLE_ADMIN: Role = {
  name: "admin",
  grants: [{ actions: ["*"], resources: ["*"] }],
};

export const ROLE_DEVELOPER: Role = {
  name: "developer",
  grants: [
    {
      actions: ["read", "write", "execute", "use"],
      resources: ["provider:*", "model:*", "tool:*", "command:*", "agent-role:*"],
    },
  ],
};

export const ROLE_VIEWER: Role = {
  name: "viewer",
  grants: [{ actions: ["read"], resources: ["*"] }],
};

export const ROLE_DEFAULT: Role = {
  name: "default",
  grants: [{ actions: ["read"], resources: ["provider:*", "model:*"] }],
};

/** The built-in roles keyed by name, newest-registration order preserved. */
export const BUILTIN_ROLES: readonly Role[] = [
  ROLE_ADMIN,
  ROLE_DEVELOPER,
  ROLE_VIEWER,
  ROLE_DEFAULT,
];

export const DEFAULT_ROLE_NAME = "default";
