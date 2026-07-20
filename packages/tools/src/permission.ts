/**
 * PermissionGate — the approval/sandbox policy in front of every tool call.
 *
 * A decision is a function of four things, evaluated in order:
 *   1. denylist  — a hard "no" for matching tool names (wins over everything).
 *   2. allowlist — a pre-approved "yes" that skips the mode policy and any ask.
 *   3. mode policy — maps the tool's permission class to allow / deny / ask.
 *   4. approve callback — resolves an `ask` to yes/no; absent ⇒ deny.
 *
 * The escalation ladder across modes is deliberate:
 *   plan            read only; no writes, exec, or network at all.
 *   read-only       read allowed; write/exec denied; network asks.
 *   workspace-write read + write allowed; exec/network ask.
 *   full-access     everything allowed outright.
 *
 * Arguments shown to the approver and recorded in the decision are redacted, so
 * a secret passed to a tool never lands in an approval prompt or audit log.
 */

import { redactArgs } from "./redact.js";
import type { Tool, ToolPermission } from "./types.js";

export type PermissionMode = "read-only" | "workspace-write" | "full-access" | "plan";

type Outcome = "allow" | "deny" | "ask";

const MODE_POLICY: Record<PermissionMode, Record<ToolPermission, Outcome>> = {
  plan: { read: "allow", write: "deny", exec: "deny", network: "deny" },
  "read-only": { read: "allow", write: "deny", exec: "deny", network: "ask" },
  "workspace-write": { read: "allow", write: "allow", exec: "ask", network: "ask" },
  "full-access": { read: "allow", write: "allow", exec: "allow", network: "allow" },
};

/**
 * The capability ranking of the escalation ladder (least → most privileged).
 * Used to intersect a parent gate with a requested child mode so delegation can
 * only ever narrow — never widen — the capability envelope.
 */
const MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  "read-only": 1,
  "workspace-write": 2,
  "full-access": 3,
};

/** What the approve callback is shown. `input` is already redacted. */
export interface ApprovalRequest {
  toolName: string;
  permission: ToolPermission;
  mode: PermissionMode;
  input: unknown;
  reason: string;
}

export type ApproveFn = (req: ApprovalRequest) => boolean | Promise<boolean>;

export interface PermissionGateOptions {
  mode: PermissionMode;
  /** Resolves `ask` decisions. When omitted, every `ask` becomes a deny. */
  approve?: ApproveFn;
  /** Tool-name patterns (`*` wildcard) that are always allowed, skipping ask. */
  allowlist?: string[];
  /** Tool-name patterns (`*` wildcard) that are always denied. Wins over all. */
  denylist?: string[];
}

export interface PermissionDecision {
  allowed: boolean;
  toolName: string;
  permission: ToolPermission;
  mode: PermissionMode;
  /** Human-readable justification, safe to log. */
  reason: string;
  /** True when an `ask` was resolved by the approve callback. */
  viaApproval: boolean;
  /** Redacted arguments recorded for the audit log. */
  loggedInput: unknown;
}

/** Compile a `*`-glob tool-name pattern into an anchored RegExp. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function matchesAny(patterns: readonly string[] | undefined, name: string): boolean {
  if (!patterns) return false;
  return patterns.some((p) => patternToRegExp(p).test(name));
}

export class PermissionGate {
  private mode: PermissionMode;
  private readonly approve: ApproveFn | undefined;
  private readonly allowlist: string[];
  private readonly denylist: string[];

  constructor(opts: PermissionGateOptions) {
    this.mode = opts.mode;
    this.approve = opts.approve;
    this.allowlist = opts.allowlist ? [...opts.allowlist] : [];
    this.denylist = opts.denylist ? [...opts.denylist] : [];
  }

  getMode(): PermissionMode {
    return this.mode;
  }

  /**
   * Derive a child gate that can never exceed this (parent) gate's capabilities
   * — the monotonic ceiling that keeps delegation from escalating privilege.
   *
   * The child's mode is the *more restrictive* of the parent's mode and the
   * optionally-requested `childMode` (min on the escalation ladder); a child may
   * narrow but never widen. The parent's denylist and approve callback are
   * carried forward (denylist unioned with the parent's, approver preserved) so
   * an operator's hard "no" and approval prompt survive every delegation hop.
   */
  deriveChild(childMode?: PermissionMode): PermissionGate {
    const mode =
      childMode !== undefined && MODE_RANK[childMode] < MODE_RANK[this.mode]
        ? childMode
        : this.mode;
    const opts: PermissionGateOptions = {
      mode,
      allowlist: [...this.allowlist],
      denylist: [...this.denylist],
    };
    if (this.approve) opts.approve = this.approve;
    return new PermissionGate(opts);
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode;
  }

  /**
   * Decide whether `tool` may run with `input`. Never throws for a plain denial
   * — it returns `allowed: false` with a reason. The caller enforces the
   * decision (skips the run and surfaces `reason` to the model/user).
   */
  async check(tool: Tool, input: unknown): Promise<PermissionDecision> {
    const loggedInput = redactArgs(input);
    // Effective permission: a tool MAY refine its class per call (e.g. a DB tool
    // that is `read` for a local sqlite file but `network` for a remote server,
    // or `write` for a mutation). `permissionFor` is authoritative when present;
    // any throw falls back to the declared `permission` so we always fail closed
    // rather than skip the gate.
    let permission: ToolPermission = tool.permission;
    if (typeof tool.permissionFor === "function") {
      try {
        permission = tool.permissionFor(input);
      } catch {
        permission = tool.permission;
      }
    }
    const base = {
      toolName: tool.name,
      permission,
      mode: this.mode,
      loggedInput,
    } as const;

    if (matchesAny(this.denylist, tool.name)) {
      return { ...base, allowed: false, viaApproval: false, reason: "denied by denylist" };
    }

    if (matchesAny(this.allowlist, tool.name)) {
      return { ...base, allowed: true, viaApproval: false, reason: "allowed by allowlist" };
    }

    const outcome = MODE_POLICY[this.mode][permission];

    if (outcome === "allow") {
      return {
        ...base,
        allowed: true,
        viaApproval: false,
        reason: `${permission} permitted in ${this.mode} mode`,
      };
    }

    if (outcome === "deny") {
      return {
        ...base,
        allowed: false,
        viaApproval: false,
        reason: `${permission} not permitted in ${this.mode} mode`,
      };
    }

    // outcome === "ask"
    if (!this.approve) {
      return {
        ...base,
        allowed: false,
        viaApproval: false,
        reason: `${permission} requires approval in ${this.mode} mode, but no approver is configured`,
      };
    }

    const reason = `${permission} requires approval in ${this.mode} mode`;
    const granted = await this.approve({
      toolName: tool.name,
      permission,
      mode: this.mode,
      input: loggedInput,
      reason,
    });

    return {
      ...base,
      allowed: granted,
      viaApproval: true,
      reason: granted ? `${reason}: approved` : `${reason}: denied`,
    };
  }
}
