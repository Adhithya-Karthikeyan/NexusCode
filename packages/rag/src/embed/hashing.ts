/**
 * HashingEmbedder — a deterministic, network-free embedder for offline use and
 * tests (system-spec §16). It projects text into a fixed-dimension vector via
 * the hashing trick over two feature families:
 *   - whole word tokens (the dominant signal), and
 *   - character n-grams (subword bridge — gives near-synonyms that share
 *     morphology, e.g. `config`/`configuration`, a nonzero similarity).
 * The result is L2-normalized so dot product is cosine similarity in `[0, 1]`.
 *
 * An optional `lexicon` canonicalizes tokens before hashing (e.g. `car→vehicle`),
 * the seam that lets true synonyms embed close together; applied identically at
 * index and query time. This is NOT a learned model — it is a stable, honest
 * lexical/subword vectorizer that stands in for a real embedder offline.
 */

import { charNgrams, fnv1a, l2normalize, tokenize } from "../text.js";
import type { Embedder } from "../types.js";

export interface HashingEmbedderOptions {
  /** Vector dimensionality (default 512). */
  dims?: number;
  /** Character n-gram size for the subword features (default 3; 0 disables). */
  ngram?: number;
  /** Weight of subword features relative to whole-word features (default 0.5). */
  ngramWeight?: number;
  /** Optional token → canonical-token map applied before hashing (synonym seam). */
  lexicon?: Record<string, string>;
  /** Id override (default `hashing-<dims>`). */
  id?: string;
}

export class HashingEmbedder implements Embedder {
  readonly id: string;
  readonly dims: number;
  private readonly ngram: number;
  private readonly ngramWeight: number;
  private readonly lexicon: Record<string, string>;

  constructor(opts: HashingEmbedderOptions = {}) {
    this.dims = opts.dims ?? 512;
    if (!Number.isInteger(this.dims) || this.dims <= 0) {
      throw new Error(`HashingEmbedder: dims must be a positive integer, got ${this.dims}`);
    }
    this.ngram = opts.ngram ?? 3;
    this.ngramWeight = opts.ngramWeight ?? 0.5;
    this.lexicon = opts.lexicon ?? {};
    this.id = opts.id ?? `hashing-${this.dims}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  /** Synchronous single-text embedding (handy for callers that don't need a batch). */
  embedOne(text: string): number[] {
    const vec = new Array<number>(this.dims).fill(0);
    for (const raw of tokenize(text)) {
      const token = this.lexicon[raw] ?? raw;
      this.addFeature(vec, `w:${token}`, 1);
      if (this.ngram > 0) {
        for (const g of charNgrams(token, this.ngram)) {
          this.addFeature(vec, `c:${g}`, this.ngramWeight);
        }
      }
    }
    return l2normalize(vec);
  }

  private addFeature(vec: number[], feature: string, weight: number): void {
    const bucket = fnv1a(feature) % this.dims;
    vec[bucket] = vec[bucket]! + weight;
  }
}

/** Convenience factory. */
export function createHashingEmbedder(opts: HashingEmbedderOptions = {}): HashingEmbedder {
  return new HashingEmbedder(opts);
}
