/**
 * The semantic token registry (design spec §4.2) — the frozen public API of the
 * theme layer. **No component ever names a raw color**; every visual role is a
 * token here, and every theme must fill all of them (unless it `extends`).
 *
 * 74 required role tokens across 11 groups. Brand tokens (§4.2 "brand") are
 * additive and optional — derived from the required set when a theme omits them.
 */

/** Provider identity tokens — one hue per strand (§1.2, §5). */
export const PROVIDER_TOKENS = [
  "provider.anthropic",
  "provider.openai",
  "provider.google",
  "provider.xai",
  "provider.ollama",
  "provider.mistral",
  "provider.deepseek",
  "provider.custom",
] as const;

/** The 12 Pygments-mapped syntax scopes (§4.7). */
export const SYNTAX_TOKENS = [
  "syntax.keyword",
  "syntax.function",
  "syntax.type",
  "syntax.string",
  "syntax.number",
  "syntax.comment",
  "syntax.operator",
  "syntax.variable",
  "syntax.constant",
  "syntax.tag",
  "syntax.attribute",
  "syntax.invalid",
] as const;

/**
 * All 74 required semantic tokens, in group order (§4.2). Declared `as const`
 * so `Record<TokenId, …>` forces every theme to be exhaustive at compile time.
 */
export const TOKEN_IDS = [
  // surface (5)
  "surface.sunken",
  "surface.base",
  "surface.raised",
  "surface.overlay",
  "surface.inset",
  // text (5)
  "text.primary",
  "text.secondary",
  "text.muted",
  "text.inverse",
  "text.link",
  // chrome (6)
  "chrome.border",
  "chrome.border.subtle",
  "chrome.border.strong",
  "chrome.borderFocus",
  "chrome.title",
  "chrome.divider",
  // accent (4)
  "accent.default",
  "accent.emphasis",
  "accent.muted",
  "accent.fg",
  // state (12)
  "success.fg",
  "success.bg",
  "success.border",
  "warning.fg",
  "warning.bg",
  "warning.border",
  "error.fg",
  "error.bg",
  "error.border",
  "info.fg",
  "info.bg",
  "info.border",
  // stream (3)
  "stream.cursor",
  "stream.thinking",
  "stream.text",
  // diff (6)
  "diff.added.fg",
  "diff.added.bg",
  "diff.removed.fg",
  "diff.removed.bg",
  "diff.context",
  "diff.gutter",
  // syntax (12)
  ...SYNTAX_TOKENS,
  // provider (8)
  ...PROVIDER_TOKENS,
  // cost (3)
  "cost.ok",
  "cost.warn",
  "cost.crit",
  // misc (10)
  "selection.bg",
  "selection.fg",
  "focus.ring",
  "badge.bg",
  "badge.fg",
  "scrollbar.track",
  "scrollbar.thumb",
  "spinner",
  "link.visited",
  "overlay.scrim",
] as const;

/** A required semantic token id. */
export type TokenId = (typeof TOKEN_IDS)[number];

/** Fast membership set for validation. */
export const TOKEN_ID_SET: ReadonlySet<string> = new Set(TOKEN_IDS);

/** Optional brand/delight tokens (§4.2 "brand", additive). */
export const BRAND_TOKEN_IDS = [
  "brand.node",
  "brand.wordmark.fg",
  "brand.wordmark.accent",
  "delight.shimmer.a",
  "delight.shimmer.b",
  "delight.shimmer.c",
  "delight.burst",
] as const;

export type BrandTokenId = (typeof BRAND_TOKEN_IDS)[number];

/**
 * Text attributes carried by a resolved color. These make color meaning survive
 * a no-color terminal — "color is never load-bearing" (§1.3.2). Names match
 * Ink's `<Text>` boolean props so the TUI can spread them directly.
 */
export type TextAttr =
  | "bold"
  | "dim"
  | "underline"
  | "reverse"
  | "italic"
  | "strikethrough";

/**
 * Default per-token attributes. Encodes the spec's mandatory redundant cues
 * (§4.3 ansi_fallback excerpt, §3.5 diff, §4.7 invalid) so that even auto-derived
 * fallbacks — and full monochrome mode — keep meaning: diff adds underline,
 * removes strike, invalid is bold, focus reverses, dim roles dim, primary bolds.
 */
export const DEFAULT_TOKEN_ATTRS: Partial<Record<TokenId, readonly TextAttr[]>> = {
  "text.primary": ["bold"],
  "text.muted": ["dim"],
  "stream.thinking": ["dim"],
  "diff.added.fg": ["underline"],
  "diff.removed.fg": ["strikethrough"],
  "diff.context": ["dim"],
  "syntax.comment": ["dim"],
  "syntax.invalid": ["bold"],
  "error.fg": ["bold"],
  "focus.ring": ["reverse"],
  "selection.bg": ["reverse"],
};
