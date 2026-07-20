/**
 * Theme construction helper. Takes a complete 74-token map and auto-derives the
 * additive brand/delight tokens (§4.2 "brand") from the required set, so each
 * signature theme stays DRY while still exposing `brand.node`, the wordmark
 * hues, the shimmer trio, and the burst color.
 */

import type { TokenId } from "../tokens.js";
import type { NexusTheme, NexusThemeMeta } from "../types.js";

export interface ThemeSpec {
  meta: NexusThemeMeta;
  primitives?: Record<string, string>;
  tokens: Record<TokenId, string>;
}

export function defineTheme(spec: ThemeSpec): NexusTheme {
  const t = spec.tokens;
  return {
    meta: spec.meta,
    primitives: spec.primitives ?? {},
    tokens: t,
    brand: {
      "brand.node": t["accent.default"],
      "brand.wordmark.fg": t["text.primary"],
      "brand.wordmark.accent": t["accent.default"],
      "delight.shimmer.a": t["stream.cursor"],
      "delight.shimmer.b": t["accent.default"],
      "delight.shimmer.c": t["accent.emphasis"],
      "delight.burst": t["accent.emphasis"],
    },
  };
}
