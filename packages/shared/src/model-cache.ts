/**
 * A tiny TTL memoizer for provider model discovery (`ProviderAdapter.listModels`
 * / the provenance-aware `listModelsWithSource`).
 *
 * Model catalogs change rarely within a session, but a picker may ask for them
 * repeatedly (every time it opens). Hitting the provider's `/models` endpoint on
 * every open is wasteful, so each adapter wraps its loader in one of these and
 * serves a cached list for `ttlMs`. In-flight de-duplication ensures two rapid
 * opens share a single request rather than racing two.
 *
 * Pure and offline: the cache never touches the network itself — it only stores
 * whatever its loader returns (including a curated fallback, which is a perfectly
 * valid thing to cache briefly).
 */

import type { ModelInfo } from "./capabilities.js";

/**
 * Whether a model list actually came from asking the provider (a live,
 * THIS-RUN probe that reached the backend and got a real answer) or is the
 * built-in static fallback (no credential to probe with, the probe failed,
 * the backend returned nothing, or the adapter has no live discovery at
 * all). A CLOSED two-value union, not a boolean — matching this repo's
 * convention for anything a client must react to differently rather than
 * render identically (`GoalVerdict`/`AgentVerdict`'s three-valued outcome,
 * `ApprovalCause`'s four-valued settlement reason, `NexusProvider
 * .localServerReachable`'s reachability triple): `"fallback"` is not a
 * degraded or partial `"provider"` result, it is a DIFFERENT KIND of
 * answer — the CLI's own best guess, not a confirmed fact — and the whole
 * point of this type is that it must never be allowed to render
 * indistinguishably from a verified one.
 *
 * Two values, not three: unlike `localServerReachable` (where a network
 * timeout creates a genuine third "we don't know yet" state that later
 * resolves), a model list is always EXACTLY one or the other by the time
 * anything reads it — the probe already ran (or didn't) and the loader
 * already picked a branch. There is no pending/unknown middle state to
 * preserve.
 */
export type ModelListSource = "provider" | "fallback";

/** A model list plus where it came from. */
export interface ModelListResult {
  models: ModelInfo[];
  source: ModelListSource;
}

export interface ModelListCache {
  /**
   * Return the cached result if it is still fresh, otherwise call `loader`,
   * cache its result (models AND source together — a cache hit must never
   * separate a list from the provenance it was tagged with) for `ttlMs`, and
   * return it. Concurrent callers during a load share the single in-flight
   * promise.
   */
  get(loader: () => Promise<ModelListResult>): Promise<ModelListResult>;
  /** Drop any cached value so the next `get` reloads. */
  clear(): void;
}

/** Create a {@link ModelListCache} with a `ttlMs` freshness window (default 60s). */
export function createModelListCache(ttlMs = 60_000): ModelListCache {
  let value: ModelListResult | undefined;
  let expiresAt = 0;
  let inflight: Promise<ModelListResult> | undefined;

  return {
    async get(loader: () => Promise<ModelListResult>): Promise<ModelListResult> {
      const now = Date.now();
      if (value !== undefined && now < expiresAt) return value;
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const result = await loader();
          value = result;
          expiresAt = Date.now() + ttlMs;
          return result;
        } finally {
          inflight = undefined;
        }
      })();
      return inflight;
    },
    clear(): void {
      value = undefined;
      expiresAt = 0;
    },
  };
}
