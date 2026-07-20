/**
 * Authorization hook — adapts an {@link Authorizer} into a `HookBus` handler so
 * enterprise RBAC/policy becomes a decision source the harness consults at the
 * SAME pre-tool gate point the PermissionGate runs at. It does not rewrite the
 * PermissionGate: it plugs in as an additional `pre-tool` (or `on-approval`)
 * handler that VETOES a denied call via the existing veto contract.
 *
 * `@nexuscode/hooks` payload/verdict types are structural, so this file couples
 * only to their SHAPE — no engine dependency is introduced.
 */

import type { HookHandler, HookPayloads, HookVerdict } from "@nexuscode/hooks";

import type { Principal } from "../rbac/types.js";
import { Authorizer } from "./authorizer.js";
import type { AuthorizationContext } from "./types.js";

/** The tool-permission classes the PermissionGate emits, mapped to RBAC verbs. */
const PERMISSION_ACTION: Record<string, string> = {
  read: "read",
  write: "write",
  exec: "execute",
  network: "use",
};

/** Map a tool `permission` string to an RBAC action (defaults to `use`). */
export function actionForToolPermission(permission: string | undefined): string {
  return (permission && PERMISSION_ACTION[permission]) || "use";
}

export interface AuthorizationHookOptions {
  authorizer: Authorizer;
  /**
   * Resolve the acting principal for a pre-tool payload. Given the payload's
   * `sessionId` (when present); return `undefined` to skip the check (observe
   * only) — use a fixed principal for a single-tenant deployment.
   */
  resolvePrincipal: (sessionId: string | undefined) => Principal | undefined;
  /** Optional per-call context (cost/time/dataClass) for policy conditions. */
  resolveContext?: (
    payload: HookPayloads["pre-tool"],
  ) => AuthorizationContext | undefined;
  /** Called for every decision (allow or deny) — e.g. to feed the audit log. */
  onDecision?: (info: {
    principal: Principal;
    action: string;
    resource: string;
    allowed: boolean;
    reason: string;
  }) => void;
}

/**
 * Build a `pre-tool` handler that denies a tool call the authorizer rejects.
 * Returns a veto (`{ block: true, reason }`) on denial; nothing on allow.
 */
export function createAuthorizationHook(
  opts: AuthorizationHookOptions,
): HookHandler<"pre-tool"> {
  const { authorizer, resolvePrincipal, resolveContext, onDecision } = opts;
  return (payload) => {
    const principal = resolvePrincipal(payload.sessionId);
    if (!principal) return; // no identity ⇒ observe only (gate still applies)

    const action = actionForToolPermission(payload.permission);
    const resource = `tool:${payload.toolName}`;
    const context = resolveContext?.(payload);
    const decision = authorizer.authorize({
      principal,
      action,
      resource,
      ...(context ? { context } : {}),
    });

    onDecision?.({
      principal,
      action,
      resource,
      allowed: decision.allowed,
      reason: decision.reason,
    });

    if (!decision.allowed) {
      const verdict: HookVerdict<HookPayloads["pre-tool"]> = {
        block: true,
        reason: decision.reason,
      };
      return verdict;
    }
    return;
  };
}
