/**
 * Savings accounting. A {@link CacheAccounting} tracks request-level hit / miss /
 * write counts and the running estimate of tokens + USD *saved* by serving
 * responses from cache instead of re-invoking a provider. Typed caches call
 * {@link CacheAccounting.recordHit} with the tokens a hit avoided (and either a
 * precomputed cost or a {@link Pricing} row to derive it).
 */

import type { Pricing } from "@nexuscode/shared";
import { computeCost } from "@nexuscode/shared";
import type { BackendMetrics, CacheStats, Savings } from "./types.js";

export class CacheAccounting {
  private hits = 0;
  private misses = 0;
  private writes = 0;
  private savedInputTokens = 0;
  private savedOutputTokens = 0;
  private savedCostUsd = 0;

  /** Record a cache hit, folding in the tokens/cost it avoided. */
  recordHit(saved?: Savings, pricing?: Pricing): void {
    this.hits += 1;
    if (!saved) return;
    const inTok = saved.inputTokens ?? 0;
    const outTok = saved.outputTokens ?? 0;
    this.savedInputTokens += inTok;
    this.savedOutputTokens += outTok;
    if (saved.costUsd != null) {
      this.savedCostUsd += saved.costUsd;
    } else if (pricing) {
      this.savedCostUsd += computeCost(
        { inputTokens: inTok, outputTokens: outTok },
        pricing,
      );
    }
  }

  recordMiss(): void {
    this.misses += 1;
  }

  recordWrite(): void {
    this.writes += 1;
  }

  /** Fraction of reads served from cache. */
  hitRate(): number {
    const reads = this.hits + this.misses;
    return reads === 0 ? 0 : this.hits / reads;
  }

  /** Build a full {@link CacheStats} by merging in backend + size figures. */
  snapshot(backend: string, metrics: BackendMetrics, size: number): CacheStats {
    return {
      backend,
      hits: this.hits,
      misses: this.misses,
      writes: this.writes,
      evictions: metrics.evictions,
      expirations: metrics.expirations,
      size,
      hitRate: this.hitRate(),
      savedInputTokens: this.savedInputTokens,
      savedOutputTokens: this.savedOutputTokens,
      savedTokens: this.savedInputTokens + this.savedOutputTokens,
      estimatedCostSavedUsd: this.savedCostUsd,
    };
  }

  /** Reset all counters (used when a cache is cleared). */
  reset(): void {
    this.hits = 0;
    this.misses = 0;
    this.writes = 0;
    this.savedInputTokens = 0;
    this.savedOutputTokens = 0;
    this.savedCostUsd = 0;
  }
}
