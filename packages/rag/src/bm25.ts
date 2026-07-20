/**
 * BM25 keyword index (system-spec §16 "hybrid search" — the lexical half).
 * Dependency-free and deterministic. Scores are the classic Okapi BM25 with the
 * usual `k1`/`b` defaults; `scoreAll` returns raw (unnormalized) scores keyed by
 * chunk id so the hybrid layer can min-max them against the semantic signal.
 *
 * This is the "pure keyword" baseline the tests use to prove hybrid + semantic
 * wins on a synonym case where exact tokens do not overlap.
 */

import { tokenize } from "./text.js";
import type { Chunk } from "./types.js";

interface Posting {
  id: string;
  /** term → frequency within this chunk. */
  tf: Map<string, number>;
  /** total token count (document length). */
  length: number;
}

export interface Bm25Options {
  /** Term-frequency saturation (default 1.5). */
  k1?: number;
  /** Length-normalization strength in `[0, 1]` (default 0.75). */
  b?: number;
}

export class Bm25Index {
  private readonly k1: number;
  private readonly b: number;
  private postings: Posting[] = [];
  /** term → number of chunks containing it. */
  private df = new Map<string, number>();
  private avgdl = 0;

  constructor(opts: Bm25Options = {}) {
    this.k1 = opts.k1 ?? 1.5;
    this.b = opts.b ?? 0.75;
  }

  /** Replace the whole index from a chunk set (called after any store mutation). */
  rebuild(chunks: Chunk[]): void {
    this.postings = [];
    this.df = new Map();
    let totalLen = 0;
    for (const chunk of chunks) {
      const tokens = tokenize(chunk.text);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
      this.postings.push({ id: chunk.id, tf, length: tokens.length });
      totalLen += tokens.length;
    }
    this.avgdl = this.postings.length > 0 ? totalLen / this.postings.length : 0;
  }

  /** Raw BM25 score for every chunk against `query`. Chunks scoring ≤ 0 are omitted. */
  scoreAll(query: string): Map<string, number> {
    const out = new Map<string, number>();
    const terms = tokenize(query);
    if (terms.length === 0 || this.postings.length === 0) return out;
    const n = this.postings.length;

    // Precompute idf per unique query term.
    const idf = new Map<string, number>();
    for (const term of new Set(terms)) {
      const df = this.df.get(term) ?? 0;
      // Okapi idf with the +1 smoothing that keeps it non-negative.
      idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
    }

    for (const post of this.postings) {
      let score = 0;
      for (const [term, weight] of idf) {
        const tf = post.tf.get(term) ?? 0;
        if (tf === 0) continue;
        const denom =
          tf + this.k1 * (1 - this.b + (this.b * post.length) / (this.avgdl || 1));
        score += weight * ((tf * (this.k1 + 1)) / denom);
      }
      if (score > 0) out.set(post.id, score);
    }
    return out;
  }
}
