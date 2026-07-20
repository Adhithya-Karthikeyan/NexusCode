/**
 * Audit-log types (system-spec §25 Enterprise / §18 Security). A security-
 * relevant event recorded as a hash-chained, redacted, append-only record.
 */

/**
 * The closed set of security-relevant audit actions. Deny-by-default policy
 * lives elsewhere; the audit log only *records* what happened, but constraining
 * the action space keeps the log queryable and prevents free-form drift.
 */
export type AuditAction =
  // authentication
  | "auth.login"
  | "auth.logout"
  | "auth.token" // token issued / validated / rejected
  // run lifecycle
  | "run.start"
  | "run.end"
  // tool execution + approval
  | "tool.call"
  | "tool.approval" // an approval/permission decision on a tool call
  // configuration
  | "config.change"
  // authorization
  | "policy.decision"
  | "rbac.decision"
  // credentials
  | "provider.key_access";

/** The outcome of an authorization-style event. */
export type AuditDecision = "allow" | "deny" | "success" | "failure" | "info";

/** Fields a caller supplies when recording an event. */
export interface AuditInput {
  /** Who performed / triggered the action (principal id, subject, token id). */
  actor: string;
  /** The action performed. */
  action: AuditAction;
  /** RBAC role of the actor at the time, if known. */
  role?: string;
  /** The object acted upon (tool name, config key, provider id, run id). */
  resource?: string;
  /** Outcome; defaults to "info" when omitted. */
  decision?: AuditDecision;
  /** Free-form structured context — redacted before it is stored/hashed. */
  details?: Record<string, unknown>;
  /** Session correlation id, if any. */
  sessionId?: string;
  /** Override the timestamp (ms since epoch). Defaults to Date.now(). */
  ts?: number;
}

/**
 * A committed audit record. `prevHash` links to the previous record's `hash`;
 * `hash = HMAC-SHA256(key, prevHash + canonical(record-without-hash))`. Every
 * string/details field is already redacted at this point, so no credential is
 * ever committed to the chain (or to the hash input).
 */
export interface AuditRecord {
  /**
   * Record-shape / chain-algorithm version (see `hashchain.ts`
   * `AUDIT_RECORD_VERSION`). Included in the hashed content, so downgrading it
   * on a forged record is itself caught as a hash mismatch.
   */
  v: number;
  /** 0-based monotonic sequence number within the chain. */
  seq: number;
  ts: number;
  actor: string;
  action: AuditAction;
  role?: string;
  resource?: string;
  decision: AuditDecision;
  details?: Record<string, unknown>;
  sessionId?: string;
  /** Hash of the previous record (GENESIS_HASH for the first). */
  prevHash: string;
  /** HMAC-SHA256 hex of `prevHash + canonical(this record without hash)`. */
  hash: string;
}

/** Filter for {@link AuditLog.query}. All conditions are AND-ed. */
export interface AuditQuery {
  actor?: string;
  action?: AuditAction;
  /** Match any of these actions. */
  actions?: AuditAction[];
  role?: string;
  resource?: string;
  decision?: AuditDecision;
  /** Inclusive lower time bound (ms). */
  from?: number;
  /** Inclusive upper time bound (ms). */
  to?: number;
}

/** One tamper finding produced by chain verification. */
export interface AuditTamper {
  seq: number;
  reason:
    | "hash-mismatch"
    | "prev-hash-mismatch"
    | "seq-mismatch"
    | "genesis-mismatch"
    /**
     * The signed head-anchor file (separate from the log, see `log.ts`
     * `verifyFile`) is missing, forged, or disagrees with the on-disk chain's
     * record count / head hash — catches tail-truncation and rollback, which a
     * replayed hash chain alone cannot (a truncated prefix still verifies).
     */
    | "anchor-mismatch";
  detail: string;
}

/** Result of verifying a chain. `ok` is true only when nothing was found. */
export interface AuditVerifyResult {
  ok: boolean;
  count: number;
  tampered: AuditTamper[];
}
