/**
 * The token → color resolver (design spec §4.1 pipeline):
 *
 *   token → theme.tokens[id] → deref primitive → capability gate
 *         → quantize to terminal palette → ResolvedColor { fg, attrs }
 *
 * Truecolor keeps the hex; 256-color quantizes to the xterm cube; 16-color maps
 * to the nearest ANSI base; no-color/monochrome returns **attributes only**.
 * Results are memoized per (theme, capability, token).
 */

import { parseColorValue, rgbToAnsi16, rgbToAnsi256, type Rgb } from "./color.js";
import { DEFAULT_TOKEN_ATTRS, type TextAttr, type TokenId } from "./tokens.js";
import type { ColorMode, NexusTheme, ResolveCaps, ResolvedColor } from "./types.js";

function capsMode(caps: ResolveCaps): ColorMode {
  if (caps.noColor) return "mono";
  if (caps.truecolor) return "truecolor";
  if (caps.colors256) return "ansi256";
  return "ansi16";
}

function attrsFor(theme: NexusTheme, token: TokenId): readonly TextAttr[] {
  const override = theme.ansiFallback?.[token]?.attrs;
  if (override) return override;
  return DEFAULT_TOKEN_ATTRS[token] ?? [];
}

function rawValue(theme: NexusTheme, token: TokenId): string | undefined {
  return theme.tokens[token];
}

/**
 * Resolve one token against a theme + terminal capability. Never throws for a
 * present token; if a value is somehow unparseable it degrades to monochrome
 * (attributes only) rather than crashing the render — a pure renderer must
 * always produce a frame.
 */
export function resolveColor(
  theme: NexusTheme,
  token: TokenId,
  caps: ResolveCaps = {},
): ResolvedColor {
  const mode = capsMode(caps);
  const attrs = attrsFor(theme, token);

  if (mode === "mono") {
    return { mode, attrs };
  }

  const value = rawValue(theme, token);
  const rgb: Rgb | null = value === undefined ? null : parseColorValue(value, theme.primitives);
  if (!rgb) {
    // Unresolvable → safe monochrome degrade (still carries attrs).
    return { mode: "mono", attrs };
  }

  const hex = `#${[rgb.r, rgb.g, rgb.b]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("")}`;

  if (mode === "truecolor") {
    return { mode, attrs, rgb, hex, ansi256: rgbToAnsi256(rgb), ansi16: rgbToAnsi16(rgb) };
  }
  if (mode === "ansi256") {
    return { mode, attrs, rgb, hex, ansi256: rgbToAnsi256(rgb), ansi16: rgbToAnsi16(rgb) };
  }
  // ansi16
  return { mode, attrs, rgb, hex, ansi256: rgbToAnsi256(rgb), ansi16: rgbToAnsi16(rgb) };
}

function capsKey(caps: ResolveCaps): string {
  return `${caps.noColor ? 1 : 0}:${caps.truecolor ? 1 : 0}:${caps.colors256 ? 1 : 0}`;
}

const cache = new WeakMap<NexusTheme, Map<string, ResolvedColor>>();

/**
 * A memoizing resolver bound to one theme + capability set. This is what
 * `ThemeProvider`/`useToken` sits on: constant-time token lookups after the
 * first resolution, flushed by swapping the bound theme (a theme hot-swap is a
 * new resolver, §4.4).
 */
export function createThemeResolver(
  theme: NexusTheme,
  caps: ResolveCaps = {},
): (token: TokenId) => ResolvedColor {
  const key = capsKey(caps);
  let perTheme = cache.get(theme);
  if (!perTheme) {
    perTheme = new Map();
    cache.set(theme, perTheme);
  }
  const memo = perTheme;
  return (token: TokenId): ResolvedColor => {
    const cacheKey = `${key}|${token}`;
    const hit = memo.get(cacheKey);
    if (hit) return hit;
    const resolved = resolveColor(theme, token, caps);
    memo.set(cacheKey, resolved);
    return resolved;
  };
}

/**
 * Convenience: the single Ink-consumable color string for a resolved token, or
 * `undefined` in monochrome mode. Truecolor → hex; 256 → the index; 16 → the
 * ANSI name. The TUI can also read the structured fields directly.
 */
export function inkColor(resolved: ResolvedColor): string | number | undefined {
  switch (resolved.mode) {
    case "truecolor":
      return resolved.hex;
    case "ansi256":
      return resolved.ansi256;
    case "ansi16":
      return resolved.ansi16;
    case "mono":
      return undefined;
  }
}
