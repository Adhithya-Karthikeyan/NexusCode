/**
 * Compression seam. Oversized chunks are shrunk to a target token count. The
 * default preserves the head and the tail and drops the middle — because for
 * tool output and logs the head (what was asked) and the tail (the error/result)
 * are the signal, and the middle is the filler (feature-catalog: tool-output
 * capping with tail preservation).
 */

import type { Compressor, TokenEstimator } from "./types.js";

const MARKER = "\n…[truncated]…\n";

/**
 * Truncate to fit `targetTokens`, keeping ~60% head and ~40% tail. If the text
 * already fits, it is returned unchanged with `summarized: false`.
 */
export const truncateMiddle: Compressor = (text, targetTokens, estimate) => {
  const current = estimate(text);
  if (targetTokens <= 0) {
    return { text: "", tokens: 0, summarized: text.length > 0 };
  }
  if (current <= targetTokens) {
    return { text, tokens: current, summarized: false };
  }
  // ~4 chars/token; leave room for the marker.
  const budgetChars = Math.max(0, targetTokens * 4 - MARKER.length);
  const headChars = Math.ceil(budgetChars * 0.6);
  const tailChars = budgetChars - headChars;
  const head = text.slice(0, headChars);
  const tail = tailChars > 0 ? text.slice(text.length - tailChars) : "";
  const out = head + MARKER + tail;
  return { text: out, tokens: estimate(out), summarized: true };
};

/**
 * Tail-preserving truncation: keep the last `targetTokens` (used for terminal
 * output where the bottom of the log is the result). Head is dropped.
 */
export function truncateTail(text: string, targetTokens: number, estimate: TokenEstimator): string {
  if (targetTokens <= 0) return "";
  if (estimate(text) <= targetTokens) return text;
  const tailChars = Math.max(0, targetTokens * 4 - MARKER.length);
  return MARKER.trimStart() + text.slice(text.length - tailChars);
}
