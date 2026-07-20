/**
 * Lexical relevance scoring and token estimation. Deliberately dependency-free
 * and deterministic: this is the default {@link ScoreFn} and the seam an
 * embedding-backed scorer will later replace. No provider/network calls here.
 */

import type { MemoryItem, ScoreFn } from "./types.js";

const WORD = /[a-z0-9]+/g;

/** Lowercase word tokens, length ≥ 2, deduped is left to callers. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const m of text.toLowerCase().matchAll(WORD)) {
    if (m[0].length >= 2) out.push(m[0]);
  }
  return out;
}

/**
 * Rough token estimate for context budgeting (~4 chars/token, floored at the
 * word count so short-but-wordy text is never undercounted). Good enough to
 * budget recall; not a substitute for a provider tokenizer.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const byChars = Math.ceil(text.length / 4);
  const byWords = (text.trim().match(/\S+/g) ?? []).length;
  return Math.max(byChars, byWords);
}

/**
 * Default lexical scorer. Combines:
 *  - term overlap between query and item text (the dominant signal),
 *  - a boost when a query term matches an item tag,
 *  - a small boost when a query term appears in the item's source,
 *  - a tiny precedence boost for items carrying a `precedence:<n>` tag
 *    (lower n = nearer/project-scoped ⇒ ranked above global), so ingested
 *    project instructions outrank user/global ones on ties.
 * Returns 0 when nothing matches.
 */
export const lexicalScore: ScoreFn = (query, item) => {
  const terms = new Set(tokenize(query));
  if (terms.size === 0) return 0;

  const textCounts = new Map<string, number>();
  for (const t of tokenize(item.text)) textCounts.set(t, (textCounts.get(t) ?? 0) + 1);

  const tagSet = new Set<string>();
  for (const tag of item.tags ?? []) for (const t of tokenize(tag)) tagSet.add(t);

  const sourceSet = new Set(tokenize(item.source ?? ""));

  let score = 0;
  for (const term of terms) {
    const tf = textCounts.get(term) ?? 0;
    if (tf > 0) score += 1 + Math.log1p(tf); // saturating term frequency
    if (tagSet.has(term)) score += 1.5;
    if (sourceSet.has(term)) score += 0.5;
  }

  if (score > 0) score += precedenceBoost(item);
  return score;
};

/** Extract `precedence:<n>` from tags; nearer (smaller n) ⇒ larger boost. */
export function precedenceBoost(item: MemoryItem): number {
  for (const tag of item.tags ?? []) {
    const m = /^precedence:(\d+)$/.exec(tag);
    if (m) {
      const n = Number(m[1]);
      return 0.25 / (1 + n); // depth 0 ⇒ +0.25, depth 1 ⇒ +0.125, …
    }
  }
  return 0;
}
