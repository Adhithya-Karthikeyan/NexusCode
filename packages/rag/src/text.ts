/**
 * Dependency-free, deterministic text/vector primitives shared across the RAG
 * pipeline. No provider or network calls live here — everything is pure so the
 * offline embedder and tests are byte-stable across runs and machines.
 */

const WORD = /[a-z0-9]+/g;

/** Lowercase word tokens of length ≥ 2 (matches the memory subsystem's rule). */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(WORD)) {
    if (m[0].length >= 2) out.push(m[0]);
  }
  return out;
}

/**
 * Character n-grams for a single token, padded with boundary markers so prefix/
 * suffix structure is captured. `"cat"` → `"^ca"`, `"cat"`, `"at$"` for n=3.
 * These give the offline embedder partial credit for morphological variants
 * (e.g. `config` ↔ `configuration`).
 */
export function charNgrams(token: string, n: number): string[] {
  const padded = `^${token}$`;
  if (padded.length <= n) return [padded];
  const out: string[] = [];
  for (let i = 0; i + n <= padded.length; i++) out.push(padded.slice(i, i + n));
  return out;
}

/** FNV-1a 32-bit hash — fast, deterministic, well-distributed for feature hashing. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** In-place L2 normalization. A zero vector is left untouched. */
export function l2normalize(vec: number[]): number[] {
  let sumSq = 0;
  for (const v of vec) sumSq += v * v;
  if (sumSq === 0) return vec;
  const inv = 1 / Math.sqrt(sumSq);
  for (let i = 0; i < vec.length; i++) vec[i] = vec[i]! * inv;
  return vec;
}

/** Dot product. For L2-normalized inputs this is cosine similarity. */
export function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/**
 * Min-max normalize a map of raw scores to `[0, 1]`. When all values are equal
 * (including a single candidate) every present score maps to `1` so the signal
 * is neutral rather than silently zeroed. Ids absent from the map read as `0`.
 */
export function minMaxNormalize(scores: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (scores.size === 0) return out;
  let min = Infinity;
  let max = -Infinity;
  for (const v of scores.values()) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  for (const [k, v] of scores) {
    out.set(k, range === 0 ? 1 : (v - min) / range);
  }
  return out;
}
