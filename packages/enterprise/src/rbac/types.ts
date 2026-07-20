/**
 * RBAC types (system-spec §25 Enterprise). A principal holds roles; a role
 * holds positive `grants`; a grant permits a set of ACTIONS over a set of
 * RESOURCE patterns. There is NO deny in RBAC — the model is allow-only and
 * FAILS CLOSED: an action on a resource is permitted only when some role grants
 * it. Explicit deny lives in the policy engine (see ../policy).
 *
 * Resources are namespaced strings `type:id`:
 *   provider:<id>     e.g. provider:openai
 *   model:<id>        e.g. model:gpt-4o
 *   tool:<name>       e.g. tool:fs_write
 *   command:<name>    e.g. command:deploy
 *   agent-role:<name> e.g. agent-role:reviewer
 */

/** The five resource namespaces the permission model governs. */
export type ResourceType = "provider" | "model" | "tool" | "command" | "agent-role";

export const RESOURCE_TYPES: readonly ResourceType[] = [
  "provider",
  "model",
  "tool",
  "command",
  "agent-role",
];

/**
 * The conventional actions. `Action` is kept open (`string`) so callers may use
 * finer-grained verbs, but these are the ones the built-in roles reason about.
 * `"*"` in a grant means "every action".
 */
export type Action = "read" | "write" | "execute" | "use" | "manage" | (string & {});

/**
 * One positive permission: `actions` over `resources`. Both accept `"*"` (or a
 * `*`-glob such as `tool:*`). An empty list matches nothing (fail closed).
 */
export interface Grant {
  actions: readonly string[];
  resources: readonly string[];
}

/** A named role: a set of grants, optionally inheriting other roles' grants. */
export interface Role {
  name: string;
  grants: readonly Grant[];
  /** Names of roles whose grants are unioned into this one (cycle-safe). */
  inherits?: readonly string[];
}

/** An authenticated actor and the roles it holds. */
export interface Principal {
  id: string;
  roles: readonly string[];
}

/** The explained result of a `can`/`explain` check. */
export interface RbacDecision {
  allowed: boolean;
  /** Human-readable justification, safe to log. */
  reason: string;
  /** The role whose grant permitted the action, when allowed. */
  role?: string;
  /** The grant that matched, when allowed. */
  grant?: Grant;
}

/** The on-disk / config shape a {@link RoleStore} can be built from. */
export interface RoleStoreData {
  /** Custom roles (merged over the built-ins unless `includeBuiltins` is false). */
  roles?: readonly Role[];
  /** Optional principal directory, so a store can resolve id → roles. */
  principals?: readonly Principal[];
  /**
   * Role assigned to a principal that names no roles (and to unknown principals
   * when `strict` is false). Defaults to `"default"`.
   */
  defaultRole?: string;
}
