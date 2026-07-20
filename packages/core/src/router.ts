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
 *   2. `runWithFailover(candidates, makeRun, scope)` is the differentiator: it
 *      streams the first candidate and, **only before the first real output
 *      chunk is emitted**, transparently fails over to the next candidate on a
 *      retryable/terminal provider error (rate_limit / overloaded / transport /
 *      cli_exit). It never replays a partially-emitted stream — the same
 *      "retry-only-before-first-chunk" invariant `resilience.ts` enforces. The
 *      hand-off is *visible*: the winning candidate's `run-start` carries a
 *      `raw.failover` trail and an `onFailover` hook fires, so the UI can render
 *      "failed over A → B".
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
        raw.push({ providerId, modelId: m.id, aliases: m.aliases ?? [], order: order++ });
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
    const ordered = this.order(rule, pool, localExtra);
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
const FAILOVER_CODES: ReadonlySet<string> = new Set(["rate_limit", "overloaded", "transport", "cli_exit"]);

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
  /** Override which errors trigger failover (default {@link isFailoverEligible}). */
  isEligible?: (err: AdapterError) => boolean;
  /**
   * Skip a candidate entirely (e.g. health flipped unhealthy since selection).
   * Returning `false` drops it without an attempt.
   */
  isHealthy?: (candidate: RouteCandidate) => boolean;
}

/** Non-content preamble chunks — their arrival does NOT count as "streaming began". */
function isPreambleChunk(chunk: StreamChunk): boolean {
  return chunk.type === "run-start" || chunk.type === "session-init";
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
 * a terminal `error` (or throws) that is failover-eligible **before it has
 * emitted any real output**, and another candidate remains, the failure is
 * swallowed and the next candidate is tried — its `run-start` carrying the
 * `raw.failover` trail and `onFailover` firing. Once real content has streamed,
 * failover is disabled: the terminal is forwarded verbatim (never replay a
 * partial stream). When every candidate is exhausted, the last terminal error is
 * yielded so the stream always ends on exactly one terminal chunk.
 */
export async function* runWithFailover(
  candidates: readonly RouteCandidate[],
  makeRun: (candidate: RouteCandidate) => AsyncIterable<StreamChunk>,
  scope: CancelScope,
  opts: FailoverOptions = {},
): AsyncIterable<StreamChunk> {
  const eligible = opts.isEligible ?? isFailoverEligible;
  const trail: FailoverTrailEntry[] = [];
  let attempt = 0;
  let lastError: AdapterError | undefined;
  let lastCandidate: RouteCandidate | undefined;

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
    lastCandidate = candidate;
    const hasNext = i < chain.length - 1;

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

    const flushPreamble = function* (): Generator<StreamChunk> {
      const snapshot = [...trail];
      for (const p of preamble) yield stampFailover(p, snapshot);
      preamble.length = 0;
    };

    try {
      for await (const chunk of makeRun(candidate)) {
        if (!committed) {
          if (chunk.type === "error") {
            // Terminal failure before any real output → the failover point.
            if (hasNext && eligible(chunk.error)) {
              failoverErr = chunk.error;
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

        yield chunk;
        if (chunk.type === "run-end" || chunk.type === "error") return; // clean terminal
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
      } else {
        yield* flushPreamble();
        yield { type: "error", runId: "", error: err, retryable: err.retryable };
        return;
      }
    }

    if (failoverErr) {
      // Record the hand-off and continue to the next candidate.
      const next = chain[i + 1]!;
      attempt += 1;
      lastError = failoverErr;
      trail.push({ from: candidate.providerId, to: next.providerId, code: failoverErr.code, message: failoverErr.message });
      opts.onFailover?.({ from: candidate, to: next, error: failoverErr, attempt });
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
  streamFor: (candidate: RouteCandidate, adapter: ReturnType<ProviderRegistry["get"]>) => AsyncIterable<StreamChunk>,
  scope: CancelScope,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
): (candidate: RouteCandidate) => AsyncIterable<StreamChunk> {
  return (candidate: RouteCandidate): AsyncIterable<StreamChunk> => {
    const attempt = (): AsyncIterable<StreamChunk> => {
      const adapter = registry.get(candidate.providerId); // throws → folded to an error chunk by withRetry
      return streamFor(candidate, adapter);
    };
    return withRetry(attempt, policy, scope.signal);
  };
}
