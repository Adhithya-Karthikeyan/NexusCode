/**
 * Model-layer ROUTING + LIVE FAILOVER (system-spec §2, master-plan PART B §5).
 *
 * Two concerns, kept orthogonal:
 *
 *   1. `Router.select(rule, …)` turns a declarative {@link RouteRule} into an
 *      *ordered candidate list*. It never imports a concrete adapter — it asks
 *      the {@link ProviderRegistry} for capabilities/health and orders the
 *      survivors by the rule's `optimize` axis (cost / latency / quality / local
 *      / explicit). Known-unhealthy providers are dropped up front.
 *
 *   2. `runWithFailover(candidates, makeRun, scope)` streams the first candidate
 *      and transparently fails over before useful output on a provider error
 *      another backend can solve (rate_limit / quota_exhausted / overloaded /
 *      transport / cli_exit / empty_output). After useful output, continuation
 *      is disabled by default; an explicit partial-recovery policy may authorize
 *      a provider-neutral continuation only when the tracked action state is
 *      safe. The hand-off is *visible*: the winning candidate's `run-start`
 *      carries a `raw.failover` trail and an `onFailover` hook fires, so the UI
 *      can render "failed over A → B".
 *
 * Everything here is offline-verifiable with the mock providers — no network,
 * no keys, no wall-clock dependence.
 */

import { AdapterError, type StreamChunk } from "@nexuscode/shared";
import type { Capabilities, Pricing } from "@nexuscode/shared";
import type { CancelScope } from "./cancel.js";
import type { ProviderRegistry } from "./registry.js";
import { DEFAULT_RETRY_POLICY, withRetry, type RetryPolicy } from "./resilience.js";
import type { PricingTable } from "./types.js";
import {
  ContinuationOverlapDeduplicator,
  PartialRecoveryTracker,
  type PartialRecoveryAudit,
  type PartialRecoveryPlan,
  type PartialRecoveryRequest,
  type PartialRecoveryTrackerOptions,
  type MutationRecoveryApproval,
} from "./partial-recovery.js";
import {
  ProviderCircuitBreaker,
  type ProviderCircuitLease,
  type ProviderCircuitStatus,
  type ProviderCircuitTarget,
} from "./provider-circuit.js";

// ── Route rule + candidates ───────────────────────────────────────────────────

/** The axis a {@link RouteRule} optimizes candidate order along. */
export type RouteOptimize = "cost" | "latency" | "quality" | "local" | "explicit";

/** Why a candidate landed in the ordered list (surfaced to the route UiEvent). */
export type RouteReason = RouteOptimize | "fallback";

/**
 * A declarative routing rule. `optimize` picks the ordering axis; `allow`/`deny`
 * gate which providers/models may be considered; `fallback` names extra
 * candidates appended after the optimized set (the last-resort chain). Every
 * list entry matches a candidate by provider id, native/alias model id, or the
 * `"<provider>/<model>"` pair.
 */
export interface RouteRule {
  optimize: RouteOptimize;
  /** If non-empty, only candidates matching one of these are kept. */
  allow?: string[];
  /** Candidates matching any of these are removed. */
  deny?: string[];
  /** Extra candidates appended (in order) after the optimized set. */
  fallback?: string[];
}

/** One resolved, orderable routing target. */
export interface RouteCandidate {
  providerId: string;
  modelId: string;
  /** Why this candidate is in the list (for the route UiEvent / audit log). */
  reason: RouteReason;
}

/**
 * Per-model cost/latency/quality metadata the router orders by. All optional and
 * config-driven — the CLI builds this from the loaded config so `@nexuscode/core`
 * never hardcodes a price or a ranking.
 */
export interface RouterMetadata {
  /** logical model id → {@link Pricing} (USD per 1M tokens). Used by `optimize:"cost"`. */
  pricing?: PricingTable;
  /** logical model (or provider) id → estimated latency ms. Used by `optimize:"latency"`. */
  latency?: Record<string, number>;
  /** Quality ranking, best-first, of model/provider/"provider/model" ids. Used by `optimize:"quality"`. */
  quality?: string[];
  /** Extra provider ids to treat as local, beyond the built-in defaults. */
  localProviderIds?: string[];
}

/** Options for {@link Router.select}. */
export interface SelectOptions {
  registry: ProviderRegistry;
  /** Only keep providers whose capabilities satisfy this predicate (e.g. `c => c.fileEdit`). */
  capabilitiesNeeded?: (caps: Capabilities) => boolean;
  /** Rank persistently blocked targets last, retaining them for diagnosis if all are blocked. */
  providerCircuit?: ProviderCircuitBreaker;
  /** Add account identity or customize circuit scope for one candidate. */
  circuitTargetFor?: (candidate: RouteCandidate) => ProviderCircuitTarget;
}

/** Provider ids (or id-substrings) treated as local model runtimes by default. */
const DEFAULT_LOCAL_MARKERS: readonly string[] = ["ollama", "lmstudio", "vllm", "llamacpp", "localai"];

/** True when a provider id designates a local model runtime (no cost, on-box). */
export function isLocalProvider(providerId: string, extra?: readonly string[]): boolean {
  const id = providerId.toLowerCase();
  if (extra?.some((e) => e.toLowerCase() === id)) return true;
  return DEFAULT_LOCAL_MARKERS.some((m) => id === m || id.includes(m));
}

/** Total per-MTok price of a {@link Pricing} row (input + output), the cost sort key. */
function priceOf(p: Pricing | undefined): number {
  if (!p) return Number.POSITIVE_INFINITY;
  return p.inputPerMTok + p.outputPerMTok;
}

interface RawCandidate {
  providerId: string;
  modelId: string;
  aliases: string[];
  /** Insertion order from the registry, the stable tiebreaker. */
  order: number;
  /** Persistently blocked candidates remain as last-resort diagnostics only. */
  circuitBlocked?: boolean;
}

/** Does `entry` name this candidate (by provider, model, alias, or provider/model)? */
function matches(entry: string, c: { providerId: string; modelId: string; aliases: string[] }): boolean {
  return (
    entry === c.providerId ||
    entry === c.modelId ||
    entry === `${c.providerId}/${c.modelId}` ||
    c.aliases.includes(entry)
  );
}

/** First index at which `entry ⊇ names(candidate)`; `Infinity` if never named. */
function firstMatchIndex(list: readonly string[] | undefined, c: RawCandidate): number {
  if (!list) return Number.POSITIVE_INFINITY;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (e !== undefined && matches(e, c)) return i;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * The static router. Constructed once with config-derived {@link RouterMetadata};
 * `select` is a pure function of the rule + the current registry state.
 */
export class Router {
  private readonly meta: RouterMetadata;

  constructor(meta: RouterMetadata = {}) {
    this.meta = meta;
  }

  /**
   * Resolve a {@link RouteRule} against the live registry into an ordered
   * candidate list (best first). Known-unhealthy providers and capability
   * misfits are dropped; the survivors are ordered by `rule.optimize`, then the
   * `fallback` chain is appended.
   */
  select(rule: RouteRule, opts: SelectOptions): RouteCandidate[] {
    const { registry, capabilitiesNeeded } = opts;
    const localExtra = this.meta.localProviderIds;

    // 1. Enumerate every (provider, model) the registry can currently serve,
    //    dropping known-unhealthy providers and capability misfits.
    const raw: RawCandidate[] = [];
    let order = 0;
    for (const providerId of registry.ids()) {
      const health = registry.healthOf(providerId);
      if (health && health.ok === false) continue; // known-unhealthy → skip
      const caps = registry.capabilitiesOf(providerId);
      if (capabilitiesNeeded && !capabilitiesNeeded(caps)) continue;
      for (const m of caps.models) {
        const candidate: RouteCandidate = { providerId, modelId: m.id, reason: "explicit" };
        let circuitBlocked = false;
        if (opts.providerCircuit) {
          const status = opts.providerCircuit.status(
            opts.circuitTargetFor?.(candidate) ?? { providerId, modelId: m.id },
          );
          circuitBlocked =
            status.availability === "blocked" || status.availability === "probing";
        }
        raw.push({
          providerId,
          modelId: m.id,
          aliases: m.aliases ?? [],
          order: order++,
          ...(circuitBlocked ? { circuitBlocked: true } : {}),
        });
      }
    }

    // 2. allow/deny gating.
    let pool = raw;
    if (rule.allow && rule.allow.length > 0) {
      pool = pool.filter((c) => rule.allow!.some((e) => matches(e, c)));
    }
    if (rule.deny && rule.deny.length > 0) {
      pool = pool.filter((c) => !rule.deny!.some((e) => matches(e, c)));
    }

    // 3. Order the optimized set.
    const scored = this.order(rule, pool, localExtra);
    // Keep blocked targets only as a last-resort diagnostic. This means a
    // healthy fallback is chosen immediately, while an all-blocked route still
    // reaches the circuit guard and returns the real quota/auth diagnosis.
    const ordered = [
      ...scored.filter((candidate) => !candidate.circuitBlocked),
      ...scored.filter((candidate) => candidate.circuitBlocked),
    ];
    const reason: RouteReason = rule.optimize;
    const out: RouteCandidate[] = ordered.map((c) => ({
      providerId: c.providerId,
      modelId: c.modelId,
      reason,
    }));

    // 4. Append the explicit fallback chain (deny still applies; dedupe).
    const seen = new Set(out.map((c) => `${c.providerId}/${c.modelId}`));
    for (const entry of rule.fallback ?? []) {
      for (const c of raw) {
        if (rule.deny && rule.deny.some((e) => matches(e, c))) continue;
        if (!matches(entry, c)) continue;
        const key = `${c.providerId}/${c.modelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ providerId: c.providerId, modelId: c.modelId, reason: "fallback" });
      }
    }

    return out;
  }

  /** Order `pool` by the rule's optimize axis. Registry order is the stable tiebreak. */
  private order(rule: RouteRule, pool: RawCandidate[], localExtra?: readonly string[]): RawCandidate[] {
    const byOrder = (a: RawCandidate, b: RawCandidate): number => a.order - b.order;
    const sorted = [...pool];

    switch (rule.optimize) {
      case "explicit": {
        // User-named order: rank by first appearance in `allow`, else registry order.
        sorted.sort((a, b) => {
          const d = firstMatchIndex(rule.allow, a) - firstMatchIndex(rule.allow, b);
          return d !== 0 ? d : byOrder(a, b);
        });
        return sorted;
      }
      case "cost": {
        sorted.sort((a, b) => {
          const d = this.costKey(a) - this.costKey(b);
          return d !== 0 ? d : byOrder(a, b);
        });
        return sorted;
      }
      case "latency": {
        sorted.sort((a, b) => {
          const d = this.latencyKey(a) - this.latencyKey(b);
          return d !== 0 ? d : byOrder(a, b);
        });
        return sorted;
      }
      case "quality": {
        sorted.sort((a, b) => {
          const d = this.qualityKey(a) - this.qualityKey(b);
          return d !== 0 ? d : byOrder(a, b);
        });
        return sorted;
      }
      case "local": {
        // Local providers first; within each group, cheaper first, then registry order.
        sorted.sort((a, b) => {
          const la = isLocalProvider(a.providerId, localExtra) ? 0 : 1;
          const lb = isLocalProvider(b.providerId, localExtra) ? 0 : 1;
          if (la !== lb) return la - lb;
          const d = this.costKey(a) - this.costKey(b);
          return d !== 0 ? d : byOrder(a, b);
        });
        return sorted;
      }
      default: {
        const _exhaustive: never = rule.optimize;
        return _exhaustive;
      }
    }
  }

  private costKey(c: RawCandidate): number {
    return priceOf(this.meta.pricing?.[c.modelId]);
  }

  private latencyKey(c: RawCandidate): number {
    const t = this.meta.latency;
    if (!t) return Number.POSITIVE_INFINITY;
    return t[c.modelId] ?? t[`${c.providerId}/${c.modelId}`] ?? t[c.providerId] ?? Number.POSITIVE_INFINITY;
  }

  private qualityKey(c: RawCandidate): number {
    return firstMatchIndex(this.meta.quality, c);
  }
}

// ── Live failover ─────────────────────────────────────────────────────────────

/** Adapter error codes that make failover worthwhile even if `retryable` is unset. */
const FAILOVER_CODES: ReadonlySet<string> = new Set([
  "rate_limit",
  "quota_exhausted",
  "overloaded",
  "transport",
  "cli_exit",
  "empty_output",
]);

/** True when `err` warrants failing over to the next candidate (never for user cancel). */
export function isFailoverEligible(err: AdapterError): boolean {
  if (err.code === "cancelled") return false;
  return err.retryable || FAILOVER_CODES.has(err.code);
}

/** The event fired (and logged onto the winner's `run-start.raw`) when we fail over. */
export interface FailoverEvent {
  /** The candidate that failed. */
  from: RouteCandidate;
  /** The candidate we switched to. */
  to: RouteCandidate;
  /** The normalized error that triggered the switch. */
  error: AdapterError;
  /** 1-based ordinal of this hand-off within the run. */
  attempt: number;
  /** Present when a post-output switch used the opt-in recovery protocol. */
  partialRecovery?: PartialRecoveryAudit;
}

/** One compact entry in the `run-start.raw.failover` trail (audit-log-safe). */
export interface FailoverTrailEntry {
  from: string;
  to: string;
  code: string;
  message: string;
}

/** The shape `runWithFailover` stamps onto the winning candidate's `run-start.raw`. */
export interface FailoverRaw {
  failover: FailoverTrailEntry[];
}

/** Options for {@link runWithFailover}. */
export interface FailoverOptions {
  /** Fires the moment a hand-off happens (UI "failed over A → B", trace log). */
  onFailover?: (e: FailoverEvent) => void;
  /**
   * Transaction gate immediately before a provider switch. `false` fails
   * closed with the original provider error; useful for an interactive `ask`
   * policy or an external authorization check.
   */
  beforeFailover?: (e: FailoverEvent) => boolean | Promise<boolean>;
  /** Override which errors trigger failover (default {@link isFailoverEligible}). */
  isEligible?: (err: AdapterError) => boolean;
  /**
   * Skip a candidate entirely (e.g. health flipped unhealthy since selection).
   * Returning `false` drops it without an attempt.
   */
  isHealthy?: (candidate: RouteCandidate) => boolean;
  /**
   * Disabled by default. When enabled, a late eligible error may switch only
   * when the recovery tracker proves continuation safe.
   */
  partialRecovery?: PartialRecoveryTrackerOptions & {
    originalGoal: string;
    mutationApproval?: MutationRecoveryApproval;
    onPlan?: (plan: PartialRecoveryPlan) => void;
  };
}

/** Optional persistent availability guard used by direct and routed runs. */
export interface ProviderRunGuardOptions {
  providerCircuit?: ProviderCircuitBreaker;
  circuitTargetFor?: (candidate: RouteCandidate) => ProviderCircuitTarget;
}

function blockedCircuitError(
  candidate: RouteCandidate,
  status: ProviderCircuitStatus,
): AdapterError {
  const code =
    status.lastError?.code ??
    (status.reason === "quota"
      ? "quota_exhausted"
      : status.reason === "auth"
        ? "auth"
        : status.reason === "model_unavailable"
          ? "invalid_request"
          : "overloaded");
  const until =
    status.blockedUntil === undefined
      ? ""
      : ` until ${new Date(status.blockedUntil).toISOString()}`;
  const reason = status.reason?.replaceAll("_", " ") ?? "provider failure";
  return new AdapterError(
    code,
    `${candidate.providerId}/${candidate.modelId} is temporarily unavailable: ${reason}${until}`,
    {
      providerId: candidate.providerId,
      ...(status.blockedUntil !== undefined
        ? { retryAfterMs: Math.max(0, status.blockedUntil - Date.now()) }
        : {}),
    },
  );
}

/**
 * Apply one persistent circuit lease around a fully retried provider stream.
 * Only the final outcome reaches the breaker, so same-provider retries do not
 * prematurely trip it.
 */
export async function* withProviderCircuit(
  candidate: RouteCandidate,
  makeRun: () => AsyncIterable<StreamChunk>,
  options: ProviderRunGuardOptions = {},
): AsyncIterable<StreamChunk> {
  const breaker = options.providerCircuit;
  if (!breaker) {
    yield* makeRun();
    return;
  }

  const target =
    options.circuitTargetFor?.(candidate) ?? {
      providerId: candidate.providerId,
      modelId: candidate.modelId,
    };
  const decision = breaker.tryAcquire(target);
  if (!decision.allowed) {
    const error = blockedCircuitError(candidate, decision.status);
    yield { type: "error", runId: "", error, retryable: false };
    return;
  }

  const lease: ProviderCircuitLease | undefined = decision.lease;
  try {
    for await (const chunk of makeRun()) {
      if (chunk.type === "error") breaker.recordFailure(target, chunk.error, { ...(lease ? { lease } : {}) });
      else if (chunk.type === "run-end") breaker.recordSuccess(target, lease);
      yield chunk;
      if (chunk.type === "error" || chunk.type === "run-end") return;
    }
  } catch (error) {
    breaker.recordFailure(target, error, { ...(lease ? { lease } : {}) });
    throw error;
  }
}

/** Non-content preamble chunks — their arrival does NOT count as "streaming began". */
function isPreambleChunk(chunk: StreamChunk): boolean {
  // Usage-only chunks do not commit a provider: an empty completion commonly
  // reports input usage immediately before its terminal. Buffering it keeps
  // quota/empty-output failover available until real content appears.
  return chunk.type === "run-start" || chunk.type === "session-init" || chunk.type === "usage";
}

/** Stamp the accumulated failover trail onto a `run-start` chunk's `raw`. */
function stampFailover(chunk: StreamChunk, trail: FailoverTrailEntry[]): StreamChunk {
  if (chunk.type !== "run-start" || trail.length === 0) return chunk;
  const prevRaw = (chunk.raw ?? {}) as Record<string, unknown>;
  const raw: FailoverRaw & Record<string, unknown> = { ...prevRaw, failover: trail };
  return { ...chunk, raw };
}

/**
 * Stream a candidate list with transparent live failover.
 *
 * Tries each candidate in order via `makeRun(candidate)`. If a candidate reaches
 * a failover-eligible terminal before real output, another candidate is tried.
 * After real output, a switch requires an explicitly enabled, safety-approved
 * partial recovery plan; otherwise the terminal is forwarded. When every
 * candidate is exhausted, the last terminal error is yielded so the stream
 * always ends on exactly one terminal chunk.
 */
export async function* runWithFailover(
  candidates: readonly RouteCandidate[],
  makeRun: (
    candidate: RouteCandidate,
    recovery?: PartialRecoveryRequest,
  ) => AsyncIterable<StreamChunk>,
  scope: CancelScope,
  opts: FailoverOptions = {},
): AsyncIterable<StreamChunk> {
  const eligible = opts.isEligible ?? isFailoverEligible;
  const trail: FailoverTrailEntry[] = [];
  let attempt = 0;
  let lastError: AdapterError | undefined;
  let lastCandidate: RouteCandidate | undefined;
  let pendingRecovery: PartialRecoveryPlan | undefined;

  // Filter out candidates known-unhealthy at dispatch time (health may have
  // flipped since `select`). Keeps the failover chain from wasting an attempt.
  const chain = opts.isHealthy ? candidates.filter((c) => opts.isHealthy!(c)) : [...candidates];

  if (chain.length === 0) {
    yield {
      type: "error",
      runId: "",
      error: new AdapterError("invalid_request", "no candidates available to route to"),
      retryable: false,
    };
    return;
  }

  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i]!;
    const recovery = pendingRecovery;
    pendingRecovery = undefined;
    lastCandidate = candidate;
    const hasNext = i < chain.length - 1;
    const nextCandidate = hasNext ? chain[i + 1]! : undefined;

    if (scope.signal.aborted) {
      yield { type: "error", runId: "", error: new AdapterError("cancelled", "aborted"), retryable: false };
      return;
    }

    // A losing candidate must emit NOTHING. We buffer its preamble
    // (run-start / session-init) until it "commits" — the moment its first
    // content or clean terminal arrives — then flush the buffer (stamping the
    // failover trail onto the run-start). A pre-commit eligible error discards
    // the buffer and hands off, so the winner's run-start is the only one seen.
    const preamble: StreamChunk[] = [];
    let committed = false; // real output committed → failover is now disabled
    let failoverErr: AdapterError | undefined; // set → break to next candidate
    let failoverRecovery: PartialRecoveryPlan | undefined;
    const recoveryOptions = opts.partialRecovery;
    const tracker = new PartialRecoveryTracker({
      enabled: recoveryOptions?.enabled === true,
      ...(recoveryOptions?.classifyAction
        ? { classifyAction: recoveryOptions.classifyAction }
        : {}),
      ...(recoveryOptions?.maxPartialContextCodePoints !== undefined
        ? { maxPartialContextCodePoints: recoveryOptions.maxPartialContextCodePoints }
        : {}),
    });
    if (recovery) {
      if (recovery.checkpoint.assistantText) {
        tracker.observe({
          type: "text-delta",
          runId: "",
          text: recovery.checkpoint.assistantText,
          channel: "answer",
        });
      }
      if (recovery.checkpoint.reasoning) {
        tracker.observe({
          type: "reasoning-delta",
          runId: "",
          text: recovery.checkpoint.reasoning,
        });
      }
      for (const action of recovery.checkpoint.actions) tracker.recordAction(action);
    }
    const overlap = recovery
      ? new ContinuationOverlapDeduplicator(recovery.checkpoint.assistantText)
      : undefined;
    let overlapFinished = false;

    const flushPreamble = function* (): Generator<StreamChunk> {
      const snapshot = [...trail];
      for (const p of preamble) {
        // A recovered switch is one logical public run. The original provider's
        // start was already rendered, so suppress the replacement provider's
        // duplicate start/session preamble while preserving its usage.
        if (recovery && (p.type === "run-start" || p.type === "session-init")) continue;
        yield stampFailover(p, snapshot);
      }
      preamble.length = 0;
    };

    const finishOverlap = function* (runId: string): Generator<StreamChunk> {
      if (!overlap || overlapFinished) return;
      overlapFinished = true;
      const text = overlap.finish();
      if (!text) return;
      const recoveredChunk: StreamChunk = {
        type: "text-delta",
        runId,
        text,
        channel: "answer",
        raw: { partialRecovery: recovery?.audit },
      };
      tracker.observe(recoveredChunk);
      yield recoveredChunk;
    };

    const createRecoveryPlan = (): PartialRecoveryPlan | undefined => {
      if (!recoveryOptions?.enabled || !nextCandidate) return undefined;
      const plan = tracker.createPlan({
        originalGoal: recoveryOptions.originalGoal,
        sourceProviderId: candidate.providerId,
        targetProviderId: nextCandidate.providerId,
        ...(recoveryOptions.mutationApproval
          ? { mutationApproval: recoveryOptions.mutationApproval }
          : {}),
      });
      recoveryOptions.onPlan?.(plan);
      return plan.decision === "safe" && plan.request ? plan : undefined;
    };

    try {
      for await (const sourceChunk of makeRun(candidate, recovery?.request)) {
        let chunk = sourceChunk;
        if (chunk.type === "text-delta" && chunk.channel !== "reasoning" && overlap) {
          const text = overlap.push(chunk.text);
          if (!text) continue;
          chunk = {
            ...chunk,
            text,
            raw: { partialRecovery: recovery?.audit, providerRaw: chunk.raw },
          };
        }
        if (chunk.type === "run-end" || chunk.type === "error") {
          yield* finishOverlap(chunk.runId);
        }
        tracker.observe(chunk);

        if (!committed) {
          if (chunk.type === "error") {
            // Terminal failure before any real output → the failover point.
            if (hasNext && eligible(chunk.error)) {
              failoverErr = chunk.error;
              // A recovery provider can fail before extending the answer. Carry
              // the prior checkpoint safely to the next candidate.
              if (recovery) failoverRecovery = createRecoveryPlan();
              break; // discard the buffered preamble; hand off to the next candidate
            }
            // Not eligible / last candidate → this is the real terminal.
            yield* flushPreamble();
            yield chunk;
            return;
          }
          if (isPreambleChunk(chunk)) {
            preamble.push(chunk);
            continue;
          }
          // First real chunk (content or run-end) → commit this candidate.
          committed = true;
          yield* flushPreamble();
          yield chunk;
          if (chunk.type === "run-end") return;
          continue;
        }

        if (chunk.type === "error") {
          if (hasNext && eligible(chunk.error)) {
            const plan = createRecoveryPlan();
            if (plan) {
              failoverErr = chunk.error;
              failoverRecovery = plan;
              break;
            }
          }
          yield chunk;
          return;
        }
        yield chunk;
        if (chunk.type === "run-end") return; // clean terminal
      }
    } catch (e) {
      // A thrown error (adapter that didn't fold to an error chunk). If nothing
      // real committed yet, treat like an eligible terminal error.
      if (scope.signal.aborted) {
        yield { type: "error", runId: "", error: new AdapterError("cancelled", "aborted"), retryable: false };
        return;
      }
      const err = e instanceof AdapterError ? e : new AdapterError("transport", String(e), { cause: e });
      if (!committed && hasNext && eligible(err)) {
        failoverErr = err;
        if (recovery) {
          tracker.abortOpenActions();
          failoverRecovery = createRecoveryPlan();
        }
      } else if (committed && hasNext && eligible(err)) {
        tracker.abortOpenActions();
        const plan = createRecoveryPlan();
        if (plan) {
          failoverErr = err;
          failoverRecovery = plan;
        } else {
          yield* flushPreamble();
          yield { type: "error", runId: "", error: err, retryable: err.retryable };
          return;
        }
      } else {
        yield* flushPreamble();
        yield { type: "error", runId: "", error: err, retryable: err.retryable };
        return;
      }
    }

    if (failoverErr) {
      // Record the hand-off and continue to the next candidate.
      const next = chain[i + 1]!;
      const nextAttempt = attempt + 1;
      const event: FailoverEvent = {
        from: candidate,
        to: next,
        error: failoverErr,
        attempt: nextAttempt,
        ...(failoverRecovery ? { partialRecovery: failoverRecovery.audit } : {}),
      };
      if (opts.beforeFailover && !(await opts.beforeFailover(event))) {
        yield {
          type: "error",
          runId: "",
          error: failoverErr,
          retryable: failoverErr.retryable,
          raw: { switchDeclined: true, target: next },
        };
        return;
      }
      attempt = nextAttempt;
      lastError = failoverErr;
      pendingRecovery = failoverRecovery;
      trail.push({ from: candidate.providerId, to: next.providerId, code: failoverErr.code, message: failoverErr.message });
      opts.onFailover?.(event);
      continue;
    }

    // Candidate ended without a terminal chunk and without asking to fail over.
    // Nothing more to yield — the stream is (unusually) done.
    return;
  }

  // Every candidate failed over. Emit the last error as the single terminal.
  const err =
    lastError ??
    new AdapterError("unknown", "all routing candidates failed", {
      ...(lastCandidate ? { providerId: lastCandidate.providerId } : {}),
    });
  yield { type: "error", runId: "", error: err, retryable: err.retryable };
}

// ── Registry-backed run factory (engine wiring) ───────────────────────────────

/**
 * Build a `makeRun` for {@link runWithFailover} that resolves each candidate to
 * its registry adapter and wraps the provider stream in the centralized
 * retry policy (same-provider retries happen first, then failover switches
 * providers). `streamFor` produces the raw provider stream for a resolved
 * adapter — supplied by the caller so `@nexuscode/core` stays decoupled from the
 * concrete `ChatRequest` assembly the engine already owns.
 */
export function registryRunFactory(
  registry: ProviderRegistry,
  streamFor: (
    candidate: RouteCandidate,
    adapter: ReturnType<ProviderRegistry["get"]>,
    recovery?: PartialRecoveryRequest,
  ) => AsyncIterable<StreamChunk>,
  scope: CancelScope,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  guard: ProviderRunGuardOptions = {},
): (candidate: RouteCandidate, recovery?: PartialRecoveryRequest) => AsyncIterable<StreamChunk> {
  return (
    candidate: RouteCandidate,
    recovery?: PartialRecoveryRequest,
  ): AsyncIterable<StreamChunk> => {
    const attempt = (): AsyncIterable<StreamChunk> => {
      const adapter = registry.get(candidate.providerId); // throws → folded to an error chunk by withRetry
      return streamFor(candidate, adapter, recovery);
    };
    return withProviderCircuit(
      candidate,
      () => withRetry(attempt, policy, scope.signal),
      guard,
    );
  };
}
