/**
 * Contrast checking & theme lint (design spec §4.6). WCAG 2.1 ratios for every
 * text-on-surface pair — including the 12 syntax tokens, the cost states, and
 * the dim tokens (`text.muted`/`stream.thinking`), which is exactly where
 * illegible combos slip through. Non-text UI must clear ≥3.
 */

import { contrastRatio, parseColorValue } from "./color.js";
import type { NexusTheme } from "./types.js";
import type { TokenId } from "./tokens.js";

export type WcagLevel = "AAA" | "AA" | "AA-large" | "fail";

export const WCAG_AA = 4.5;
export const WCAG_AAA = 7;
export const WCAG_AA_LARGE = 3;
export const WCAG_NON_TEXT = 3;

/** Classify a contrast ratio for normal body text. */
export function wcagLevel(ratio: number): WcagLevel {
  if (ratio >= WCAG_AAA) return "AAA";
  if (ratio >= WCAG_AA) return "AA";
  if (ratio >= WCAG_AA_LARGE) return "AA-large";
  return "fail";
}

/** Tokens that render as normal text over `surface.base` and must clear AA. */
export const TEXT_ON_SURFACE_TOKENS: readonly TokenId[] = [
  "text.primary",
  "text.secondary",
  "text.muted",
  "text.link",
  "accent.default",
  "success.fg",
  "warning.fg",
  "error.fg",
  "info.fg",
  "stream.text",
  "stream.thinking",
  "cost.ok",
  "cost.warn",
  "cost.crit",
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
];

/** One diff foreground checked against its own diff background (§5 note). */
const DIFF_PAIRS: ReadonlyArray<[fg: TokenId, bg: TokenId]> = [
  ["diff.added.fg", "diff.added.bg"],
  ["diff.removed.fg", "diff.removed.bg"],
];

export interface ContrastResult {
  token: TokenId;
  against: TokenId;
  ratio: number;
  level: WcagLevel;
  /** Did this pair meet the theme's declared `minContrast` floor? */
  pass: boolean;
}

export interface LintReport {
  themeId: string;
  floor: "AA" | "AAA";
  results: ContrastResult[];
  failures: ContrastResult[];
  ok: boolean;
}

function ratioAgainst(theme: NexusTheme, token: TokenId, against: TokenId): number {
  const fg = parseColorValue(theme.tokens[token] ?? "", theme.primitives);
  const bg = parseColorValue(theme.tokens[against] ?? "", theme.primitives);
  if (!fg || !bg) {
    throw new Error(`lint: unresolved color for ${token} / ${against} in ${theme.meta.id}`);
  }
  return contrastRatio(fg, bg);
}

/**
 * Compute the contrast ratio of a single text token against `surface.base`.
 * Public so tests and `nexus theme why` can spot-check one pair.
 */
export function tokenContrast(theme: NexusTheme, token: TokenId, against: TokenId = "surface.base"): number {
  return ratioAgainst(theme, token, against);
}

/**
 * Lint a theme's text and diff contrast against its declared `minContrast`
 * floor (default AA). Text pairs must clear AA/AAA; diff pairs are checked
 * against their own backgrounds. Returns the full result set plus failures.
 */
export function lintTheme(theme: NexusTheme): LintReport {
  const floor = theme.meta.minContrast ?? "AA";
  const floorRatio = floor === "AAA" ? WCAG_AAA : WCAG_AA;
  const results: ContrastResult[] = [];

  for (const token of TEXT_ON_SURFACE_TOKENS) {
    const ratio = ratioAgainst(theme, token, "surface.base");
    results.push({
      token,
      against: "surface.base",
      ratio,
      level: wcagLevel(ratio),
      pass: ratio >= floorRatio,
    });
  }

  for (const [fg, bg] of DIFF_PAIRS) {
    const ratio = ratioAgainst(theme, fg, bg);
    results.push({
      token: fg,
      against: bg,
      ratio,
      // Diffs are checked at AA regardless of the theme floor (readable-add/remove).
      level: wcagLevel(ratio),
      pass: ratio >= WCAG_AA,
    });
  }

  const failures = results.filter((r) => !r.pass);
  return { themeId: theme.meta.id, floor, results, failures, ok: failures.length === 0 };
}
