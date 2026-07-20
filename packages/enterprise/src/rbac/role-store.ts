/**
 * RoleStore — the config/file-backed source of roles + principal assignments,
 * and the `can` / `explain` authorization primitive.
 *
 * DESIGN — FAIL CLOSED. `can(principal, action, resource)` returns `true` ONLY
 * when some role held by the principal (directly or via inheritance) has a grant
 * matching BOTH the action AND the resource. A missing rule, an unknown role, an
 * empty grant, or a malformed resource all resolve to DENY. There is no implicit
 * allow anywhere in this file.
 */

import { readFileSync } from "node:fs";

import {
  BUILTIN_ROLES,
  DEFAULT_ROLE_NAME,
} from "./builtin-roles.js";
import { matchesAny, matchesPattern } from "./match.js";
import {
  RESOURCE_TYPES,
  type Grant,
  type Principal,
  type RbacDecision,
  type Role,
  type RoleStoreData,
  type ResourceType,
} from "./types.js";

export interface RoleStoreOptions {
  /** Seed the built-in roles (admin/developer/viewer/default). Default true. */
  includeBuiltins?: boolean;
  /** Role applied when a principal names no role. Default `"default"`. */
  defaultRole?: string;
}

/** Parse a `type:id` resource string; returns null when malformed. */
export function parseResource(
  resource: string,
): { type: ResourceType; id: string } | null {
  const idx = resource.indexOf(":");
  if (idx <= 0) return null;
  const type = resource.slice(0, idx);
  const id = resource.slice(idx + 1);
  if (id.length === 0) return null;
  if (!RESOURCE_TYPES.includes(type as ResourceType)) return null;
  return { type: type as ResourceType, id };
}

function grantMatches(grant: Grant, action: string, resource: string): boolean {
  const actionOk =
    grant.actions.includes("*") || matchesAny(grant.actions, action);
  if (!actionOk) return false;
  const resourceOk =
    grant.resources.includes("*") || matchesAny(grant.resources, resource);
  return resourceOk;
}

export class RoleStore {
  private readonly roles = new Map<string, Role>();
  private readonly principals = new Map<string, Principal>();
  private readonly defaultRole: string;

  constructor(data: RoleStoreData = {}, opts: RoleStoreOptions = {}) {
    const includeBuiltins = opts.includeBuiltins ?? true;
    if (includeBuiltins) {
      for (const r of BUILTIN_ROLES) this.roles.set(r.name, r);
    }
    for (const r of data.roles ?? []) this.roles.set(r.name, r);
    for (const p of data.principals ?? []) this.principals.set(p.id, p);
    this.defaultRole =
      opts.defaultRole ?? data.defaultRole ?? DEFAULT_ROLE_NAME;
  }

  /** Build a store from a JSON file of shape {@link RoleStoreData}. */
  static fromFile(path: string, opts: RoleStoreOptions = {}): RoleStore {
    const raw = readFileSync(path, "utf8");
    const data = JSON.parse(raw) as RoleStoreData;
    return new RoleStore(data, opts);
  }

  /** Register (or replace) a role. Returns `this` for chaining. */
  addRole(role: Role): this {
    this.roles.set(role.name, role);
    return this;
  }

  /** Assign a principal into the store's directory. Returns `this`. */
  addPrincipal(principal: Principal): this {
    this.principals.set(principal.id, principal);
    return this;
  }

  getRole(name: string): Role | undefined {
    return this.roles.get(name);
  }

  /** Resolve a principal from the directory by id, when present. */
  getPrincipal(id: string): Principal | undefined {
    return this.principals.get(id);
  }

  /**
   * Expand a principal's role names into the full set including inheritance.
   * A principal naming no known role falls back to the configured default role.
   * Cycles and unknown parents are ignored (never throw, never widen).
   */
  private resolveRoleNames(principal: Principal): string[] {
    const seed = principal.roles.filter((r) => this.roles.has(r));
    const start = seed.length > 0 ? seed : [this.defaultRole];
    const seen = new Set<string>();
    const stack = [...start];
    while (stack.length > 0) {
      const name = stack.pop() as string;
      if (seen.has(name)) continue;
      const role = this.roles.get(name);
      if (!role) continue;
      seen.add(name);
      for (const parent of role.inherits ?? []) {
        if (!seen.has(parent)) stack.push(parent);
      }
    }
    return [...seen];
  }

  /**
   * FAIL-CLOSED authorization check. `true` only when a held role grants the
   * `action` on the `resource`. Everything else is DENY.
   */
  can(principal: Principal, action: string, resource: string): boolean {
    return this.explain(principal, action, resource).allowed;
  }

  /** As {@link can}, but returns the matching role/grant and a reason. */
  explain(principal: Principal, action: string, resource: string): RbacDecision {
    if (parseResource(resource) === null) {
      return {
        allowed: false,
        reason: `malformed resource "${resource}" (expected type:id) — denied`,
      };
    }
    const roleNames = this.resolveRoleNames(principal);
    for (const name of roleNames) {
      const role = this.roles.get(name);
      if (!role) continue;
      for (const grant of role.grants) {
        if (grantMatches(grant, action, resource)) {
          return {
            allowed: true,
            reason: `role "${name}" grants ${action} on ${resource}`,
            role: name,
            grant,
          };
        }
      }
    }
    return {
      allowed: false,
      reason: `no role of principal "${principal.id}" grants ${action} on ${resource} — denied (fail closed)`,
    };
  }

  /** True when `resource` matches the given namespace (convenience for callers). */
  static resourceOfType(resource: string, type: ResourceType): boolean {
    return matchesPattern(`${type}:*`, resource) || resource === `${type}:`;
  }
}
