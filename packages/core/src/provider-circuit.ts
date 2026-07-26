/**
 * Persistent provider circuit breaker.
 *
 * Provider failures do not all have the same blast radius:
 *
 * - quota/auth failures apply to an account (or the whole provider when no
 *   account identity is available);
 * - model availability failures apply only to that model;
 * - transient transport/overload failures apply to the exact route.
 *
 * The breaker stores those scopes independently and checks every applicable
 * ancestor before dispatch. Expired open circuits admit exactly one half-open
 * probe across all cooperating processes. The JSON file is deliberately small,
 * versioned, transaction-locked, written atomically, and private (0600).
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import {
  isAdapterError,
  looksLikeQuotaExhaustion,
  type AdapterErrorCode,
} from "@nexuscode/shared";

const STORE_VERSION = 1 as const;
const MAX_ERROR_MESSAGE_LENGTH = 1_000;
const STORE_LOCK_WAIT_MS = 2_000;
const STORE_LOCK_STALE_MS = 30_000;
const PROBE_LEASE_TTL_MS = 2 * 60 * 60_000;

export type ProviderCircuitState = "closed" | "open" | "half-open";
export type ProviderCircuitReason = "quota" | "auth" | "model_unavailable" | "transient";
export type ProviderAvailability = "available" | "blocked" | "probe_available" | "probing";

/** A circuit target. Omitted account/model segments make a broader scope. */
export interface ProviderCircuitTarget {
  providerId: string;
  accountId?: string;
  modelId?: string;
}

/**
 * Optional UX/accounting metadata. The breaker does not guess costs or quota;
 * callers that know them can attach an annotation and render it beside status.
 */
export interface ProviderCircuitAnnotations {
  estimatedRequestCostUsd?: number;
  quotaRemaining?: number;
  quotaUnit?: string;
  quotaResetAt?: number;
  statusLabel?: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface ProviderCircuitError {
  code: AdapterErrorCode;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  retryAfterMs?: number;
}

/** Stable, UI-safe projection. No raw exception/cause is persisted. */
export interface ProviderCircuitStatus {
  key: string;
  /** Scope of the record producing this status (which may be an ancestor). */
  target: ProviderCircuitTarget;
  state: ProviderCircuitState;
  availability: ProviderAvailability;
  attempts: number;
  openCount: number;
  reason?: ProviderCircuitReason;
  blockedUntil?: number;
  /** Alias used by status UIs when presenting "retry after …". */
  retryAt?: number;
  openedAt?: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  lastError?: ProviderCircuitError;
  annotations?: ProviderCircuitAnnotations;
}

export interface ProviderCircuitLease {
  readonly id: string;
  readonly keys: readonly string[];
}

export type ProviderCircuitDecision =
  | {
      allowed: true;
      probe: boolean;
      status: ProviderCircuitStatus;
      lease?: ProviderCircuitLease;
    }
  | {
      allowed: false;
      probe: false;
      status: ProviderCircuitStatus;
      retryAfterMs?: number;
    };

export interface ProviderCircuitFailureOptions {
  /** Absolute time supplied by a provider/account status endpoint. */
  retryAt?: number;
  /** Quota reset time, also exposed through annotations for status UIs. */
  resetAt?: number;
  /** Lease returned by {@link ProviderCircuitBreaker.tryAcquire}. */
  lease?: ProviderCircuitLease;
  annotations?: ProviderCircuitAnnotations;
}

export interface ProviderCircuitBreakerOptions {
  /** Omit for an in-memory breaker. */
  filePath?: string;
  now?: () => number;
  transientFailureThreshold?: number;
  baseCooldownMs?: number;
  maxCooldownMs?: number;
  quotaCooldownMs?: number;
  modelUnavailableCooldownMs?: number;
  /** Backward jumps larger than this rebase deadlines instead of extending them. */
  maxClockSkewMs?: number;
  maxEntries?: number;
  onPersistenceError?: (error: Error) => void;
}

interface CircuitEntry {
  key: string;
  target: ProviderCircuitTarget;
  state: ProviderCircuitState;
  attempts: number;
  openCount: number;
  reason?: ProviderCircuitReason;
  blockedUntil?: number;
  openedAt?: number;
  lastFailureAt?: number;
  lastSuccessAt?: number;
  lastError?: ProviderCircuitError;
  annotations?: ProviderCircuitAnnotations;
  /** Persisted opaque lease shared by every Nexus process. */
  probeLeaseId?: string;
  /** Cross-process probe lease expiry; a crashed worker eventually releases itself. */
  probeLeaseExpiresAt?: number;
  /** Owning local process, used to release a crashed probe before the TTL. */
  probeLeaseOwnerPid?: number;
}

interface PersistedEntry extends CircuitEntry {}

interface PersistedStore {
  version: typeof STORE_VERSION;
  savedAt: number;
  entries: PersistedEntry[];
}

interface NormalizedOptions {
  filePath?: string;
  now: () => number;
  transientFailureThreshold: number;
  baseCooldownMs: number;
  maxCooldownMs: number;
  quotaCooldownMs: number;
  modelUnavailableCooldownMs: number;
  maxClockSkewMs: number;
  maxEntries: number;
  onPersistenceError?: (error: Error) => void;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;
}

function normalizeOptions(opts: ProviderCircuitBreakerOptions): NormalizedOptions {
  const out: NormalizedOptions = {
    now: opts.now ?? Date.now,
    transientFailureThreshold: positiveInteger(opts.transientFailureThreshold, 3),
    baseCooldownMs: positiveInteger(opts.baseCooldownMs, 30_000),
    maxCooldownMs: positiveInteger(opts.maxCooldownMs, 15 * 60_000),
    quotaCooldownMs: positiveInteger(opts.quotaCooldownMs, 60 * 60_000),
    modelUnavailableCooldownMs: positiveInteger(opts.modelUnavailableCooldownMs, 5 * 60_000),
    maxClockSkewMs: positiveInteger(opts.maxClockSkewMs, 5_000),
    maxEntries: positiveInteger(opts.maxEntries, 512),
  };
  if (opts.filePath !== undefined) out.filePath = opts.filePath;
  if (opts.onPersistenceError !== undefined) out.onPersistenceError = opts.onPersistenceError;
  return out;
}

function cleanSegment(value: string | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function normalizeTarget(target: ProviderCircuitTarget): ProviderCircuitTarget {
  const providerId = cleanSegment(target.providerId);
  if (!providerId) throw new TypeError("provider circuit target requires a non-empty providerId");
  const out: ProviderCircuitTarget = { providerId };
  const accountId = cleanSegment(target.accountId);
  const modelId = cleanSegment(target.modelId);
  if (accountId !== undefined) out.accountId = accountId;
  if (modelId !== undefined) out.modelId = modelId;
  return out;
}

/** Collision-safe, stable key suitable for persistence and CLI reset commands. */
export function providerCircuitKey(target: ProviderCircuitTarget): string {
  const t = normalizeTarget(target);
  let key = `p:${encodeURIComponent(t.providerId)}`;
  if (t.accountId !== undefined) key += `|a:${encodeURIComponent(t.accountId)}`;
  if (t.modelId !== undefined) key += `|m:${encodeURIComponent(t.modelId)}`;
  return key;
}

function appliesTo(scope: ProviderCircuitTarget, request: ProviderCircuitTarget): boolean {
  return (
    scope.providerId === request.providerId &&
    (scope.accountId === undefined || scope.accountId === request.accountId) &&
    (scope.modelId === undefined || scope.modelId === request.modelId)
  );
}

function isDescendant(scope: ProviderCircuitTarget, candidate: ProviderCircuitTarget): boolean {
  return (
    scope.providerId === candidate.providerId &&
    (scope.accountId === undefined || scope.accountId === candidate.accountId) &&
    (scope.modelId === undefined || scope.modelId === candidate.modelId)
  );
}

function specificity(target: ProviderCircuitTarget): number {
  return 1 + (target.accountId === undefined ? 0 : 1) + (target.modelId === undefined ? 0 : 1);
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b(sk|xox[baprs]|gh[pousr])[-_][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function toStoredError(error: unknown): ProviderCircuitError {
  if (isAdapterError(error)) {
    const out: ProviderCircuitError = {
      code: error.code,
      message: sanitizeErrorMessage(error.message),
      retryable: error.retryable,
    };
    if (error.opts.httpStatus !== undefined) out.httpStatus = error.opts.httpStatus;
    if (error.opts.retryAfterMs !== undefined) out.retryAfterMs = error.opts.retryAfterMs;
    return out;
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "unknown", message: sanitizeErrorMessage(message), retryable: true };
}

/**
 * Classify failures that should affect provider availability. Request-specific
 * errors (context length, content filter, cancellation, ordinary bad input)
 * return `undefined` and do not trip a circuit.
 */
export function classifyProviderCircuitFailure(error: unknown): ProviderCircuitReason | undefined {
  const stored = toStoredError(error);
  const text = stored.message.toLowerCase();
  if (stored.code === "quota_exhausted" || looksLikeQuotaExhaustion(stored.message, stored.code)) {
    return "quota";
  }
  if (
    stored.code === "auth" ||
    stored.httpStatus === 401 ||
    /\b(?:invalid|expired|revoked|missing) (?:api )?(?:key|token|credential)s?\b/.test(text)
  ) {
    return "auth";
  }
  if (
    (stored.code === "invalid_request" || stored.httpStatus === 404 || stored.httpStatus === 410) &&
    /\b(?:model|deployment)\b.*\b(?:not found|unavailable|unsupported|disabled|deprecated|decommissioned)\b/.test(
      text,
    )
  ) {
    return "model_unavailable";
  }
  if (
    stored.code === "rate_limit" ||
    stored.code === "overloaded" ||
    stored.code === "transport" ||
    stored.code === "cli_exit" ||
    stored.code === "parse" ||
    stored.code === "empty_output" ||
    stored.code === "unknown" ||
    stored.retryable ||
    (stored.httpStatus !== undefined && stored.httpStatus >= 500)
  ) {
    return "transient";
  }
  return undefined;
}

function failureScope(target: ProviderCircuitTarget, reason: ProviderCircuitReason): ProviderCircuitTarget {
  if (reason === "quota" || reason === "auth") {
    const accountScope: ProviderCircuitTarget = { providerId: target.providerId };
    if (target.accountId !== undefined) accountScope.accountId = target.accountId;
    return accountScope;
  }
  if (reason === "model_unavailable") {
    const modelScope: ProviderCircuitTarget = { providerId: target.providerId };
    if (target.accountId !== undefined) modelScope.accountId = target.accountId;
    if (target.modelId !== undefined) modelScope.modelId = target.modelId;
    return modelScope;
  }
  return target;
}

function copyAnnotations(annotations: ProviderCircuitAnnotations): ProviderCircuitAnnotations {
  const out: ProviderCircuitAnnotations = {};
  if (annotations.estimatedRequestCostUsd !== undefined) {
    out.estimatedRequestCostUsd = annotations.estimatedRequestCostUsd;
  }
  if (annotations.quotaRemaining !== undefined) out.quotaRemaining = annotations.quotaRemaining;
  if (annotations.quotaUnit !== undefined) out.quotaUnit = annotations.quotaUnit;
  if (annotations.quotaResetAt !== undefined) out.quotaResetAt = annotations.quotaResetAt;
  if (annotations.statusLabel !== undefined) out.statusLabel = annotations.statusLabel;
  if (annotations.details !== undefined) out.details = { ...annotations.details };
  return out;
}

function validAnnotations(value: unknown): ProviderCircuitAnnotations | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const out: ProviderCircuitAnnotations = {};
  if (typeof raw.estimatedRequestCostUsd === "number" && Number.isFinite(raw.estimatedRequestCostUsd)) {
    out.estimatedRequestCostUsd = raw.estimatedRequestCostUsd;
  }
  if (typeof raw.quotaRemaining === "number" && Number.isFinite(raw.quotaRemaining)) {
    out.quotaRemaining = raw.quotaRemaining;
  }
  if (typeof raw.quotaUnit === "string") out.quotaUnit = raw.quotaUnit.slice(0, 64);
  const quotaResetAt = finiteTimestamp(raw.quotaResetAt);
  if (quotaResetAt !== undefined) out.quotaResetAt = quotaResetAt;
  if (typeof raw.statusLabel === "string") out.statusLabel = raw.statusLabel.slice(0, 256);
  if (raw.details && typeof raw.details === "object" && !Array.isArray(raw.details)) {
    const details: Record<string, string | number | boolean | null> = {};
    for (const [key, item] of Object.entries(raw.details as Record<string, unknown>).slice(0, 32)) {
      if (
        item === null ||
        typeof item === "string" ||
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item))
      ) {
        details[key.slice(0, 128)] = typeof item === "string" ? item.slice(0, 512) : item;
      }
    }
    out.details = details;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function validStoredError(value: unknown): ProviderCircuitError | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.code !== "string" || typeof raw.message !== "string" || typeof raw.retryable !== "boolean") {
    return undefined;
  }
  const knownCodes: readonly AdapterErrorCode[] = [
    "auth",
    "rate_limit",
    "quota_exhausted",
    "overloaded",
    "invalid_request",
    "context_length",
    "content_filter",
    "cancelled",
    "transport",
    "cli_exit",
    "parse",
    "empty_output",
    "unknown",
  ];
  if (!knownCodes.includes(raw.code as AdapterErrorCode)) return undefined;
  const out: ProviderCircuitError = {
    code: raw.code as AdapterErrorCode,
    message: sanitizeErrorMessage(raw.message),
    retryable: raw.retryable,
  };
  if (typeof raw.httpStatus === "number" && Number.isFinite(raw.httpStatus)) out.httpStatus = raw.httpStatus;
  if (typeof raw.retryAfterMs === "number" && Number.isFinite(raw.retryAfterMs) && raw.retryAfterMs >= 0) {
    out.retryAfterMs = raw.retryAfterMs;
  }
  return out;
}

function validTarget(value: unknown): ProviderCircuitTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.providerId !== "string" || !cleanSegment(raw.providerId)) return undefined;
  const candidate: ProviderCircuitTarget = { providerId: raw.providerId };
  if (typeof raw.accountId === "string") candidate.accountId = raw.accountId;
  if (typeof raw.modelId === "string") candidate.modelId = raw.modelId;
  try {
    return normalizeTarget(candidate);
  } catch {
    return undefined;
  }
}

function validEntry(value: unknown): CircuitEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const target = validTarget(raw.target);
  if (!target) return undefined;
  const state =
    raw.state === "closed" || raw.state === "open" || raw.state === "half-open" ? raw.state : undefined;
  if (!state) return undefined;
  const attempts =
    typeof raw.attempts === "number" && Number.isFinite(raw.attempts) && raw.attempts >= 0
      ? Math.floor(raw.attempts)
      : 0;
  const openCount =
    typeof raw.openCount === "number" && Number.isFinite(raw.openCount) && raw.openCount >= 0
      ? Math.floor(raw.openCount)
      : 0;
  const reason =
    raw.reason === "quota" ||
    raw.reason === "auth" ||
    raw.reason === "model_unavailable" ||
    raw.reason === "transient"
      ? raw.reason
      : undefined;
  const entry: CircuitEntry = {
    key: providerCircuitKey(target),
    target,
    state,
    attempts,
    openCount,
  };
  if (reason !== undefined) entry.reason = reason;
  const blockedUntil = finiteTimestamp(raw.blockedUntil);
  const openedAt = finiteTimestamp(raw.openedAt);
  const lastFailureAt = finiteTimestamp(raw.lastFailureAt);
  const lastSuccessAt = finiteTimestamp(raw.lastSuccessAt);
  if (blockedUntil !== undefined) entry.blockedUntil = blockedUntil;
  if (openedAt !== undefined) entry.openedAt = openedAt;
  if (lastFailureAt !== undefined) entry.lastFailureAt = lastFailureAt;
  if (lastSuccessAt !== undefined) entry.lastSuccessAt = lastSuccessAt;
  const lastError = validStoredError(raw.lastError);
  const annotations = validAnnotations(raw.annotations);
  if (lastError !== undefined) entry.lastError = lastError;
  if (annotations !== undefined) entry.annotations = annotations;
  if (typeof raw.probeLeaseId === "string" && raw.probeLeaseId.length <= 128) {
    entry.probeLeaseId = raw.probeLeaseId;
  }
  const probeLeaseExpiresAt = finiteTimestamp(raw.probeLeaseExpiresAt);
  if (probeLeaseExpiresAt !== undefined) entry.probeLeaseExpiresAt = probeLeaseExpiresAt;
  if (
    typeof raw.probeLeaseOwnerPid === "number" &&
    Number.isInteger(raw.probeLeaseOwnerPid) &&
    raw.probeLeaseOwnerPid > 0
  ) {
    entry.probeLeaseOwnerPid = raw.probeLeaseOwnerPid;
  }
  return entry;
}

function statusOf(entry: CircuitEntry): ProviderCircuitStatus {
  const out: ProviderCircuitStatus = {
    key: entry.key,
    target: { ...entry.target },
    state: entry.state,
    availability:
      entry.state === "closed"
        ? "available"
        : entry.state === "open"
          ? "blocked"
          : entry.probeLeaseId === undefined
            ? "probe_available"
            : "probing",
    attempts: entry.attempts,
    openCount: entry.openCount,
  };
  if (entry.reason !== undefined) out.reason = entry.reason;
  if (entry.blockedUntil !== undefined) {
    out.blockedUntil = entry.blockedUntil;
    out.retryAt = entry.blockedUntil;
  }
  if (entry.openedAt !== undefined) out.openedAt = entry.openedAt;
  if (entry.lastFailureAt !== undefined) out.lastFailureAt = entry.lastFailureAt;
  if (entry.lastSuccessAt !== undefined) out.lastSuccessAt = entry.lastSuccessAt;
  if (entry.lastError !== undefined) out.lastError = { ...entry.lastError };
  if (entry.annotations !== undefined) out.annotations = copyAnnotations(entry.annotations);
  return out;
}

function closedStatus(target: ProviderCircuitTarget): ProviderCircuitStatus {
  return {
    key: providerCircuitKey(target),
    target: { ...target },
    state: "closed",
    availability: "available",
    attempts: 0,
    openCount: 0,
  };
}

export class ProviderCircuitBreaker {
  private readonly options: NormalizedOptions;
  private readonly entries = new Map<string, CircuitEntry>();
  private lastClockMs: number;
  private loadIssueValue: Error | undefined;
  private persistenceIssueValue: Error | undefined;
  private storeLockDepth = 0;

  constructor(options: ProviderCircuitBreakerOptions = {}) {
    this.options = normalizeOptions(options);
    this.lastClockMs = this.safeRawNow();
    this.load();
  }

  /** A corrupt/incompatible store is ignored rather than preventing startup. */
  get loadIssue(): Error | undefined {
    return this.loadIssueValue;
  }

  /** Last best-effort persistence failure; in-memory protection remains active. */
  get persistenceIssue(): Error | undefined {
    return this.persistenceIssueValue;
  }

  /**
   * Reserve permission to dispatch. Closed circuits allow normal concurrency;
   * expired open circuits allow exactly one half-open probe.
   */
  tryAcquire(input: ProviderCircuitTarget): ProviderCircuitDecision {
    if (this.options.filePath && this.storeLockDepth === 0) {
      return this.withStoreLock(() => this.tryAcquire(input));
    }
    const target = normalizeTarget(input);
    const now = this.now();
    const applicable = this.applicableEntries(target);
    let changed = this.expireOpenEntries(applicable, now);
    changed = this.expireProbeLeases(applicable, now) || changed;

    const hardBlocks = applicable.filter(
      (entry) =>
        entry.state === "open" ||
        (entry.state === "half-open" && entry.probeLeaseId !== undefined),
    );
    if (hardBlocks.length > 0) {
      if (changed) this.persist();
      const blocker = this.strongestBlock(hardBlocks);
      const decision: ProviderCircuitDecision = {
        allowed: false,
        probe: false,
        status: statusOf(blocker),
      };
      if (blocker.blockedUntil !== undefined) {
        decision.retryAfterMs = Math.max(0, blocker.blockedUntil - now);
      }
      return decision;
    }

    const probes = applicable.filter((entry) => entry.state === "half-open");
    if (probes.length === 0) {
      if (changed) this.persist();
      return { allowed: true, probe: false, status: this.status(target) };
    }

    const id = randomUUID();
    const keys: string[] = [];
    for (const entry of probes) {
      entry.probeLeaseId = id;
      entry.probeLeaseExpiresAt = now + PROBE_LEASE_TTL_MS;
      entry.probeLeaseOwnerPid = process.pid;
      keys.push(entry.key);
      changed = true;
    }
    if (changed) this.persist();
    const lease: ProviderCircuitLease = { id, keys };
    return { allowed: true, probe: true, status: statusOf(probes[0]!), lease };
  }

  /**
   * Record a provider failure. Returns the effective status after applying
   * classification and scope reduction. Ignored request-specific failures leave
   * the circuit closed (and release a half-open probe, if present).
   */
  recordFailure(
    input: ProviderCircuitTarget,
    error: unknown,
    options: ProviderCircuitFailureOptions = {},
  ): ProviderCircuitStatus {
    if (this.options.filePath && this.storeLockDepth === 0) {
      return this.withStoreLock(() => this.recordFailure(input, error, options));
    }
    const target = normalizeTarget(input);
    const now = this.now();
    const reason = classifyProviderCircuitFailure(error);

    if (options.lease !== undefined && !this.isActiveLease(options.lease)) {
      return this.status(target);
    }

    if (reason === undefined) {
      this.releaseProbe(options.lease, now);
      return this.status(target);
    }

    const storedError = toStoredError(error);
    const scope = failureScope(target, reason);
    const key = providerCircuitKey(scope);
    const probeKeys = this.consumeProbe(options.lease);

    // Any ancestor being probed must reopen when its probe failed, even when
    // the newly classified failure has a narrower scope.
    for (const probeKey of probeKeys) {
      const probed = this.entries.get(probeKey);
      if (!probed) continue;
      this.applyFailure(probed, reason, storedError, now, options, true);
    }

    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        target: scope,
        state: "closed",
        attempts: 0,
        openCount: 0,
      };
      this.entries.set(key, entry);
    }
    if (!probeKeys.includes(key)) {
      this.applyFailure(entry, reason, storedError, now, options, entry.state === "half-open");
    }
    if (options.annotations !== undefined) entry.annotations = copyAnnotations(options.annotations);
    if (options.resetAt !== undefined && Number.isFinite(options.resetAt) && options.resetAt >= 0) {
      entry.annotations = {
        ...(entry.annotations ?? {}),
        quotaResetAt: options.resetAt,
      };
    }
    this.prune();
    this.persist();
    return statusOf(entry);
  }

  /** A successful probe/request closes all applicable parent and exact circuits. */
  recordSuccess(input: ProviderCircuitTarget, lease?: ProviderCircuitLease): ProviderCircuitStatus {
    if (this.options.filePath && this.storeLockDepth === 0) {
      return this.withStoreLock(() => this.recordSuccess(input, lease));
    }
    const target = normalizeTarget(input);
    const now = this.now();
    if (lease !== undefined && !this.isActiveLease(lease)) return this.status(target);

    let changed = false;
    for (const entry of this.applicableEntries(target)) {
      if (lease !== undefined && entry.probeLeaseId !== undefined && entry.probeLeaseId !== lease.id) {
        continue;
      }
      entry.state = "closed";
      entry.attempts = 0;
      entry.openCount = 0;
      entry.lastSuccessAt = now;
      delete entry.reason;
      delete entry.blockedUntil;
      delete entry.openedAt;
      delete entry.lastError;
      delete entry.probeLeaseId;
      delete entry.probeLeaseExpiresAt;
      delete entry.probeLeaseOwnerPid;
      changed = true;
    }
    if (changed) this.persist();
    return this.status(target);
  }

  /**
   * Manual reset. Resetting an account/provider also clears its descendant model
   * circuits; omitting the target clears the entire store.
   */
  reset(input?: ProviderCircuitTarget): number {
    if (this.options.filePath && this.storeLockDepth === 0) {
      return this.withStoreLock(() => this.reset(input));
    }
    if (input === undefined) {
      const count = this.entries.size;
      this.entries.clear();
      this.persist();
      return count;
    }
    const target = normalizeTarget(input);
    let count = 0;
    for (const [key, entry] of this.entries) {
      if (!isDescendant(target, entry.target)) continue;
      this.entries.delete(key);
      count++;
    }
    if (count > 0) this.persist();
    return count;
  }

  /** Replace UX metadata for the exact target without changing circuit state. */
  annotate(input: ProviderCircuitTarget, annotations: ProviderCircuitAnnotations): ProviderCircuitStatus {
    if (this.options.filePath && this.storeLockDepth === 0) {
      return this.withStoreLock(() => this.annotate(input, annotations));
    }
    const target = normalizeTarget(input);
    const key = providerCircuitKey(target);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { key, target, state: "closed", attempts: 0, openCount: 0 };
      this.entries.set(key, entry);
    }
    entry.annotations = copyAnnotations(annotations);
    this.prune();
    this.persist();
    return statusOf(entry);
  }

  /** Effective status for a request, including a blocking ancestor scope. */
  status(input: ProviderCircuitTarget): ProviderCircuitStatus {
    if (this.options.filePath && this.storeLockDepth === 0) {
      return this.withStoreLock(() => this.status(input));
    }
    const target = normalizeTarget(input);
    const now = this.now();
    const applicable = this.applicableEntries(target);
    let changed = this.expireOpenEntries(applicable, now);
    changed = this.expireProbeLeases(applicable, now) || changed;
    if (changed) this.persist();
    const active = applicable.filter((entry) => entry.state !== "closed");
    if (active.length > 0) return statusOf(this.strongestBlock(active));
    const exact = this.entries.get(providerCircuitKey(target));
    if (exact) return statusOf(exact);
    const mostSpecific = [...applicable].sort((a, b) => specificity(b.target) - specificity(a.target))[0];
    return mostSpecific ? statusOf(mostSpecific) : closedStatus(target);
  }

  /** All known records, ready for `nexus providers status` or a TUI panel. */
  listStatuses(options: { includeClosed?: boolean } = {}): ProviderCircuitStatus[] {
    if (this.options.filePath && this.storeLockDepth === 0) {
      return this.withStoreLock(() => this.listStatuses(options));
    }
    const now = this.now();
    const all = [...this.entries.values()];
    let changed = this.expireOpenEntries(all, now);
    changed = this.expireProbeLeases(all, now) || changed;
    if (changed) this.persist();
    return all
      .filter((entry) => options.includeClosed === true || entry.state !== "closed")
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(statusOf);
  }

  private safeRawNow(): number {
    const value = this.options?.now?.() ?? Date.now();
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  }

  private now(): number {
    const raw = this.safeRawNow();
    if (raw < this.lastClockMs - this.options.maxClockSkewMs) {
      // Preserve remaining cooldowns across a material wall-clock correction.
      this.shiftTimestamps(raw - this.lastClockMs);
      this.lastClockMs = raw;
      return raw;
    }
    if (raw < this.lastClockMs) return this.lastClockMs;
    this.lastClockMs = raw;
    return raw;
  }

  private shiftTimestamps(delta: number): void {
    for (const entry of this.entries.values()) {
      if (entry.blockedUntil !== undefined) entry.blockedUntil = Math.max(0, entry.blockedUntil + delta);
      if (entry.openedAt !== undefined) entry.openedAt = Math.max(0, entry.openedAt + delta);
      if (entry.lastFailureAt !== undefined) {
        entry.lastFailureAt = Math.max(0, entry.lastFailureAt + delta);
      }
      if (entry.lastSuccessAt !== undefined) {
        entry.lastSuccessAt = Math.max(0, entry.lastSuccessAt + delta);
      }
      if (entry.annotations?.quotaResetAt !== undefined) {
        entry.annotations.quotaResetAt = Math.max(0, entry.annotations.quotaResetAt + delta);
      }
    }
  }

  private applicableEntries(target: ProviderCircuitTarget): CircuitEntry[] {
    return [...this.entries.values()]
      .filter((entry) => appliesTo(entry.target, target))
      .sort((a, b) => specificity(a.target) - specificity(b.target));
  }

  private expireOpenEntries(entries: readonly CircuitEntry[], now: number): boolean {
    let changed = false;
    for (const entry of entries) {
      if (entry.state !== "open" || entry.blockedUntil === undefined || entry.blockedUntil > now) continue;
      entry.state = "half-open";
      delete entry.probeLeaseId;
      delete entry.probeLeaseExpiresAt;
      delete entry.probeLeaseOwnerPid;
      changed = true;
    }
    return changed;
  }

  private expireProbeLeases(entries: readonly CircuitEntry[], now: number): boolean {
    let changed = false;
    for (const entry of entries) {
      if (entry.state !== "half-open" || entry.probeLeaseId === undefined) {
        continue;
      }
      let ownerAlive = true;
      if (entry.probeLeaseOwnerPid !== undefined && entry.probeLeaseOwnerPid !== process.pid) {
        try {
          process.kill(entry.probeLeaseOwnerPid, 0);
        } catch (error) {
          ownerAlive = (error as NodeJS.ErrnoException).code === "EPERM";
        }
      }
      const expired =
        entry.probeLeaseExpiresAt !== undefined && entry.probeLeaseExpiresAt <= now;
      if (ownerAlive && !expired) continue;
      delete entry.probeLeaseId;
      delete entry.probeLeaseExpiresAt;
      delete entry.probeLeaseOwnerPid;
      changed = true;
    }
    return changed;
  }

  private strongestBlock(entries: readonly CircuitEntry[]): CircuitEntry {
    return [...entries].sort((a, b) => {
      if (a.state === "half-open" && b.state !== "half-open") return 1;
      if (b.state === "half-open" && a.state !== "half-open") return -1;
      if (a.blockedUntil === undefined && b.blockedUntil !== undefined) return -1;
      if (b.blockedUntil === undefined && a.blockedUntil !== undefined) return 1;
      const until = (b.blockedUntil ?? 0) - (a.blockedUntil ?? 0);
      return until !== 0 ? until : specificity(b.target) - specificity(a.target);
    })[0]!;
  }

  private isActiveLease(lease: ProviderCircuitLease): boolean {
    return (
      lease.keys.length > 0 &&
      lease.keys.every((key) => this.entries.get(key)?.probeLeaseId === lease.id)
    );
  }

  private consumeProbe(lease: ProviderCircuitLease | undefined): string[] {
    if (!lease) return [];
    const keys: string[] = [];
    for (const key of lease.keys) {
      const entry = this.entries.get(key);
      if (!entry || entry.probeLeaseId !== lease.id) continue;
      delete entry.probeLeaseId;
      delete entry.probeLeaseExpiresAt;
      delete entry.probeLeaseOwnerPid;
      keys.push(key);
    }
    return keys;
  }

  private releaseProbe(lease: ProviderCircuitLease | undefined, now: number): void {
    let changed = false;
    for (const key of this.consumeProbe(lease)) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      entry.state = "open";
      entry.blockedUntil = now;
      changed = true;
    }
    if (changed) this.persist();
  }

  private applyFailure(
    entry: CircuitEntry,
    reason: ProviderCircuitReason,
    error: ProviderCircuitError,
    now: number,
    options: ProviderCircuitFailureOptions,
    wasProbe: boolean,
  ): void {
    entry.reason = reason;
    entry.attempts++;
    entry.lastFailureAt = now;
    entry.lastError = error;
    delete entry.probeLeaseId;
    delete entry.probeLeaseExpiresAt;
    delete entry.probeLeaseOwnerPid;

    const explicitRetryAt =
      options.retryAt !== undefined && Number.isFinite(options.retryAt)
        ? Math.max(now, options.retryAt)
        : options.resetAt !== undefined && Number.isFinite(options.resetAt)
          ? Math.max(now, options.resetAt)
          : error.retryAfterMs !== undefined
            ? now + Math.max(0, error.retryAfterMs)
            : undefined;

    const shouldOpen =
      reason !== "transient" ||
      wasProbe ||
      explicitRetryAt !== undefined ||
      entry.attempts >= this.options.transientFailureThreshold;
    if (!shouldOpen) {
      entry.state = "closed";
      delete entry.blockedUntil;
      delete entry.openedAt;
      return;
    }

    entry.state = "open";
    entry.openCount++;
    entry.openedAt = now;
    if (explicitRetryAt !== undefined) {
      entry.blockedUntil = explicitRetryAt;
      return;
    }
    if (reason === "auth") {
      // Credential changes/manual reset are the only reliable recovery signal.
      delete entry.blockedUntil;
      return;
    }
    if (reason === "quota") {
      entry.blockedUntil = now + this.options.quotaCooldownMs;
      return;
    }
    if (reason === "model_unavailable") {
      entry.blockedUntil = now + this.options.modelUnavailableCooldownMs;
      return;
    }
    const exponent = Math.max(0, entry.openCount - 1);
    entry.blockedUntil =
      now + Math.min(this.options.maxCooldownMs, this.options.baseCooldownMs * 2 ** exponent);
  }

  private prune(): void {
    if (this.entries.size <= this.options.maxEntries) return;
    const oldest = [...this.entries.values()].sort(
      (a, b) =>
        (a.lastFailureAt ?? a.lastSuccessAt ?? a.openedAt ?? 0) -
        (b.lastFailureAt ?? b.lastSuccessAt ?? b.openedAt ?? 0),
    );
    for (const entry of oldest) {
      if (this.entries.size <= this.options.maxEntries) break;
      if (entry.state !== "closed") continue;
      this.entries.delete(entry.key);
    }
    for (const entry of oldest) {
      if (this.entries.size <= this.options.maxEntries) break;
      this.entries.delete(entry.key);
    }
  }

  private load(): void {
    const filePath = this.options.filePath;
    if (!filePath || !existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("provider circuit store is not an object");
      }
      const raw = parsed as Record<string, unknown>;
      if (raw.version !== STORE_VERSION || !Array.isArray(raw.entries)) {
        throw new Error(`unsupported provider circuit store version: ${String(raw.version)}`);
      }
      for (const candidate of raw.entries.slice(0, this.options.maxEntries)) {
        const entry = validEntry(candidate);
        if (entry) this.entries.set(entry.key, entry);
      }
      const savedAt = finiteTimestamp(raw.savedAt);
      const now = this.lastClockMs;
      if (savedAt !== undefined && now < savedAt - this.options.maxClockSkewMs) {
        this.shiftTimestamps(now - savedAt);
      }
      this.expireOpenEntries([...this.entries.values()], now);
      this.expireProbeLeases([...this.entries.values()], now);
      this.loadIssueValue = undefined;
    } catch (error) {
      this.entries.clear();
      this.loadIssueValue = error instanceof Error ? error : new Error(String(error));
    }
  }

  private persist(): void {
    const filePath = this.options.filePath;
    if (!filePath) return;
    const savedAt = this.lastClockMs;
    const entries: PersistedEntry[] = [...this.entries.values()].map((entry) => ({ ...entry }));
    const store: PersistedStore = { version: STORE_VERSION, savedAt, entries };
    const parent = dirname(filePath);
    const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(store)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, filePath);
      chmodSync(filePath, 0o600);
      this.persistenceIssueValue = undefined;
    } catch (error) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Best effort cleanup.
        }
      }
      try {
        unlinkSync(temp);
      } catch {
        // Temp may never have been created or may already have been renamed.
      }
      const issue = error instanceof Error ? error : new Error(String(error));
      this.persistenceIssueValue = issue;
      this.options.onPersistenceError?.(issue);
    }
  }

  /**
   * Serialize every file-backed read/modify/write cycle. Each process refreshes
   * from the committed file while holding the directory lock, so independent
   * Nexus windows cannot overwrite each other's failures or reserve the same
   * half-open probe.
   */
  private withStoreLock<T>(operation: () => T): T {
    const filePath = this.options.filePath;
    if (!filePath || this.storeLockDepth > 0) return operation();
    const lockPath = `${filePath}.lock`;
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + STORE_LOCK_WAIT_MS;
    let acquired = false;
    while (!acquired) {
      try {
        mkdirSync(lockPath, { mode: 0o700 });
        acquired = true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > STORE_LOCK_STALE_MS) {
            rmSync(lockPath, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() >= deadline) {
          const issue = new Error(`timed out waiting for provider circuit lock: ${lockPath}`);
          this.persistenceIssueValue = issue;
          this.options.onPersistenceError?.(issue);
          return operation();
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    this.storeLockDepth++;
    try {
      this.entries.clear();
      this.load();
      return operation();
    } finally {
      this.storeLockDepth--;
      try {
        rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // A lock cleanup failure is recoverable through stale-lock eviction.
      }
    }
  }
}
