/**
 * EmbeddingCache — memoizes embedding vectors keyed by (model, text) so the same
 * chunk is never re-embedded (system-spec §17: embedding cache). This is the
 * workhorse behind offline RAG: with a deterministic local embedder, a warm
 * cache makes index builds idempotent and cheap.
 *
 * Savings are booked in embedding *input* tokens (embedding calls have no output
 * tokens); when `pricing` is supplied they also convert to saved USD.
 */

import type { Pricing } from "@nexuscode/shared";
import { hashKey } from "../keys.js";
import { CacheAccounting } from "../accounting.js";
import type { CacheBackend, CacheStats } from "../types.js";

export interface EmbeddingCacheOptions {
  backend: CacheBackend<number[]>;
  /** TTL (ms) for vectors; omit to use the backend default (embeddings rarely expire). */
  ttlMs?: number;
  /** Pricing per embedding model id, to convert saved tokens into saved USD. */
  pricing?: Record<string, Pricing>;
  /**
   * Token estimator for savings accounting. Defaults to a char/4 heuristic so
   * the package stays free of a tokenizer dependency.
   */
  estimateTokens?: (text: string) => number;
}

const defaultEstimate = (text: string): number => Math.ceil(text.length / 4);

export class EmbeddingCache {
  private readonly backend: CacheBackend<number[]>;
  private readonly ttlMs: number | undefined;
  private readonly pricing: Record<string, Pricing> | undefined;
  private readonly estimate: (text: string) => number;
  private readonly accounting = new CacheAccounting();

  constructor(opts: EmbeddingCacheOptions) {
    this.backend = opts.backend;
    this.ttlMs = opts.ttlMs;
    this.pricing = opts.pricing;
    this.estimate = opts.estimateTokens ?? defaultEstimate;
  }

  /** Deterministic key for a (model, text) pair. */
  key(model: string, text: string): string {
    return hashKey("embedding", model, text);
  }

  /** Look up a cached vector; books saved embedding tokens on a hit. */
  async get(model: string, text: string): Promise<number[] | undefined> {
    const value = await this.backend.get(this.key(model, text));
    if (value) {
      this.accounting.recordHit({ inputTokens: this.estimate(text) }, this.pricing?.[model]);
    } else {
      this.accounting.recordMiss();
    }
    return value;
  }

  /** Store a vector for a (model, text) pair. */
  async set(model: string, text: string, vector: number[]): Promise<void> {
    await this.backend.set(this.key(model, text), vector, {
      ...(this.ttlMs !== undefined ? { ttlMs: this.ttlMs } : {}),
    });
    this.accounting.recordWrite();
  }

  /**
   * Batch helper: for each text, return the cached vector or `undefined`. Only
   * the misses need to hit the embedder; call {@link set} for each afterwards.
   */
  async getMany(model: string, texts: string[]): Promise<(number[] | undefined)[]> {
    return Promise.all(texts.map((t) => this.get(model, t)));
  }

  async clear(): Promise<void> {
    await this.backend.clear();
    this.accounting.reset();
  }

  async stats(): Promise<CacheStats> {
    return this.accounting.snapshot(this.backend.name, this.backend.metrics(), await this.backend.size());
  }
}
