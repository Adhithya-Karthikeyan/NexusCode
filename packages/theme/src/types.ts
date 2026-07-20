/**
 * Public theme types — the marketplace/shareable file shape and the resolved
 * output the TUI consumes. Kept ink-free: the resolver emits structured color
 * data (hex + ansi256 + ansi16 + attrs) and the client picks the field its
 * terminal supports.
 */

import type { Ansi16Name, Rgb } from "./color.js";
import type { BrandTokenId, TextAttr, TokenId } from "./tokens.js";

/**
 * A color literal in a theme file. `@name` dereferences a primitive ramp entry
 * (§4.3). All other forms are parsed directly by `parseColorValue`.
 */
export type ColorValue =
  | `#${string}`
  | `rgb(${string})`
  | `hsl(${string})`
  | `@${string}`;

/** Theme metadata block (§4.3). */
export interface NexusThemeMeta {
  id: string;
  name: string;
  author?: string;
  version?: string;
  mode: "dark" | "light";
  /** OS light/dark auto-pairing (§4.5). */
  followsOs?: boolean;
  /** Sibling theme id for auto-pairing. */
  pairId?: string;
  /** Inherit tokens from another registered theme. */
  extends?: string;
  license?: string;
  /** Contrast floor the theme claims to meet (§4.6). */
  minContrast?: "AA" | "AAA";
}

/** An explicit per-token ANSI fallback override (§4.3). */
export interface AnsiFallbackEntry {
  ansi: Ansi16Name;
  attrs?: readonly TextAttr[];
}

/**
 * A fully-specified theme — the runtime shape after validation and primitive
 * deref. This is also the marketplace JSON shape (`.nexustheme`).
 */
export interface NexusTheme {
  meta: NexusThemeMeta;
  /** Named raw ramps referenced by `@name`. May be empty. */
  primitives: Record<string, string>;
  /** All 74 semantic tokens (§4.2). Complete unless `meta.extends` is set. */
  tokens: Record<TokenId, ColorValue | string>;
  /** Optional additive brand/delight tokens. */
  brand?: Partial<Record<BrandTokenId, ColorValue | string>>;
  /** Optional explicit ANSI fallbacks; auto-derived from hex when absent. */
  ansiFallback?: Partial<Record<TokenId, AnsiFallbackEntry>>;
}

/** Which color depth the resolver should target. */
export type ColorMode = "truecolor" | "ansi256" | "ansi16" | "mono";

/**
 * Terminal color capability the resolver gates on — the color-relevant slice of
 * the TUI's full `CapabilityProvider` (spec §3.0). Truecolor wins over 256 wins
 * over 16; `noColor` forces monochrome regardless.
 */
export interface ResolveCaps {
  truecolor?: boolean;
  colors256?: boolean;
  /** NO_COLOR / `--plain` / screen-reader → attributes only, no color. */
  noColor?: boolean;
}

/**
 * A resolved color, ready for Ink. In `mono` mode `hex`/`ansi256`/`ansi16` are
 * absent and only `attrs` carry meaning (the "returns attributes not colors"
 * contract). `attrs` is always present.
 */
export interface ResolvedColor {
  mode: ColorMode;
  attrs: readonly TextAttr[];
  rgb?: Rgb;
  hex?: string;
  ansi256?: number;
  ansi16?: Ansi16Name;
}
