/**
 * PromptCache — memoizes assembled prompt artifacts keyed by the *stable static
 * prefix* (system-spec §17: prompt cache). The Context Engine renders a
 * cache-stable `system` string; re-assembling it every turn is wasteful when the
 * static context hasn't changed. PromptCache stores the derived artifact (the
 * rendered prefix, its token count and cache breakpoints) under a hash of that
 * prefix, so an identical static context is a hit and skips re-work.
 *
 * The key is derived only from cache-stable inputs (model + static prefix), never
 * from volatile tail content, which is exactly why it stays hot across turns.
 */

import { hashKey } from "../keys.js";
import { CacheAccounting } from "../accounting.js";
import type { CacheBackend, CacheStats } from "../types.js";

/** The cached artifact for one static prefix. */
export interface PromptCacheValue {
  /** The rendered, cache-stable system prefix. */
  system: string;
  /** Token count of the prefix (from the engine's estimator). */
  tokens: number;
  /** Cache-breakpoint token offsets over the static lanes (may be empty). */
  breakpoints?: number[];
}

export interface PromptCacheOptions {
  backend: CacheBackend<PromptCacheValue>;
  /** TTL (ms) for prompt entries; omit to use the backend default. */
  ttlMs?: number;
}

export class PromptCache {
  private readonly backend: CacheBackend<PromptCacheValue>;
  private readonly ttlMs: number | undefined;
  private readonly accounting = new CacheAccounting();

  constructor(opts: PromptCacheOptions) {
    this.backend = opts.backend;
    this.ttlMs = opts.ttlMs;
  }

  /** Deterministic key for a (model, static-prefix) pair. */
  key(model: string, system: string): string {
    return hashKey("prompt", model, system);
  }

  /** Look up a cached prefix artifact; records a hit/miss for accounting. */
  async get(model: string, system: string): Promise<PromptCacheValue | undefined> {
    const value = await this.backend.get(this.key(model, system));
    if (value) {
      // Saved work ≈ the prefix tokens we didn't have to re-tokenize/re-emit.
      this.accounting.recordHit({ inputTokens: value.tokens });
    } else {
      this.accounting.recordMiss();
    }
    return value;
  }

  /** Store a rendered prefix artifact. */
  async set(model: string, value: PromptCacheValue): Promise<void> {
    await this.backend.set(this.key(model, value.system), value, {
      ...(this.ttlMs !== undefined ? { ttlMs: this.ttlMs } : {}),
    });
    this.accounting.recordWrite();
  }

  async clear(): Promise<void> {
    await this.backend.clear();
    this.accounting.reset();
  }

  async stats(): Promise<CacheStats> {
    return this.accounting.snapshot(this.backend.name, this.backend.metrics(), await this.backend.size());
  }
}
