/**
 * A tiny TTL memoizer for provider model discovery (`ProviderAdapter.listModels`).
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

export interface ModelListCache {
  /**
   * Return the cached list if it is still fresh, otherwise call `loader`, cache
   * its result for `ttlMs`, and return it. Concurrent callers during a load
   * share the single in-flight promise.
   */
  get(loader: () => Promise<ModelInfo[]>): Promise<ModelInfo[]>;
  /** Drop any cached value so the next `get` reloads. */
  clear(): void;
}

/** Create a {@link ModelListCache} with a `ttlMs` freshness window (default 60s). */
export function createModelListCache(ttlMs = 60_000): ModelListCache {
  let value: ModelInfo[] | undefined;
  let expiresAt = 0;
  let inflight: Promise<ModelInfo[]> | undefined;

  return {
    async get(loader: () => Promise<ModelInfo[]>): Promise<ModelInfo[]> {
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
