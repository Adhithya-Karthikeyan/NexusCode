/**
 * `<Icon>` (design spec §1.3.3, §3.0) — the single glyph resolver. Every glyph
 * ships an ASCII fallback; the resolver **width-probes** the intended unicode
 * marker against a reference display-width oracle and **downgrades** any glyph
 * that does not occupy exactly its expected cell count (or when unicode is off /
 * `--ascii` / `TERM=dumb`). This keeps bordered/aligned regions single-cell —
 * "no emoji inside aligned regions; only stable single-cell markers there".
 *
 * The width probe is injectable (`measure`) so the boot-time capability probe can
 * pin a validated `string-width` implementation; the built-in `stringWidth` is the
 * default text-presentation oracle and is a pure, headless-testable function.
 */

import { Text } from "ink";
import type { Capabilities } from "../caps/capabilities.js";
import { useCaps } from "../caps/CapabilityProvider.js";
import type { InkTextStyle } from "../theme/ThemeProvider.js";

/** Named single-cell markers used across chrome, panels, HUD, and overlays. */
export type IconName =
  | "node" // brand diamond ◆
  | "focus" // focused-title caret ▸
  | "prompt" // input caret ▸
  | "streaming" // in-flight refresh ⟳
  | "ok"
  | "warn"
  | "error"
  | "info"
  | "running" // loading ◴
  | "bolt" // failover ⚡
  | "dotFilled" // active provider ●
  | "dotHollow" // available provider ○
  | "chevronRight"
  | "chevronDown"
  | "barFull"
  | "barEmpty"
  | "autocompact" // ⧗ compaction tick
  | "star" // ★ winner / promoted
  | "search" // 🔎 (astral → downgrades in aligned rows)
  | "bell" // 🔔 notification (astral → downgrades)
  | "close"; // ✕

interface IconDef {
  unicode: string;
  ascii: string;
  /** Expected display width in cells (default 1). A probe mismatch downgrades. */
  width?: number;
}

/** The ASCII-fallback + expected-width table (§3.0 owns this). */
export const ICONS: Record<IconName, IconDef> = {
  node: { unicode: "◆", ascii: "*" },
  focus: { unicode: "▸", ascii: ">" },
  prompt: { unicode: "▸", ascii: ">" },
  streaming: { unicode: "⟳", ascii: "~" },
  ok: { unicode: "✓", ascii: "v" },
  warn: { unicode: "⚠", ascii: "!" },
  error: { unicode: "✗", ascii: "x" },
  info: { unicode: "ℹ", ascii: "i" },
  running: { unicode: "◴", ascii: "o" },
  bolt: { unicode: "⚡", ascii: "!" },
  dotFilled: { unicode: "●", ascii: "*" },
  dotHollow: { unicode: "○", ascii: "o" },
  chevronRight: { unicode: "▸", ascii: ">" },
  chevronDown: { unicode: "▾", ascii: "v" },
  barFull: { unicode: "▓", ascii: "#" },
  barEmpty: { unicode: "░", ascii: "-" },
  autocompact: { unicode: "⧗", ascii: "t" },
  star: { unicode: "★", ascii: "*" },
  search: { unicode: "🔎", ascii: ":" },
  bell: { unicode: "🔔", ascii: "!" },
  close: { unicode: "✕", ascii: "x" },
};

function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    cp === 0x200b || // zero-width space
    cp === 0xfeff || // BOM / zero-width no-break space
    (cp >= 0x200c && cp <= 0x200f) || // ZWNJ/ZWJ/marks
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0x1f3fb && cp <= 0x1f3ff) // emoji skin-tone modifiers
  );
}

function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs
    (cp >= 0x1f000 && cp <= 0x1faff) || // astral emoji / symbols
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
  );
}

/**
 * Reference display width in terminal cells (text-presentation oracle). Combining
 * marks / variation selectors are 0, CJK & astral-emoji code points are 2, all
 * other printable code points are 1. Pure and headless-testable; the boot probe
 * can replace it with a terminal-measured implementation via `Icon`'s `measure`.
 */
export function stringWidth(str: string): number {
  let width = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isZeroWidth(cp)) continue;
    width += isWide(cp) ? 2 : 1;
  }
  return width;
}

/**
 * Resolve a glyph for the current capabilities and width oracle. Downgrades to the
 * ASCII fallback when unicode is disabled or the intended glyph fails its
 * single-cell width check (the width-probe downgrade, §3.0).
 */
export function resolveIcon(
  name: IconName,
  caps: Pick<Capabilities, "unicode">,
  measure: (s: string) => number = stringWidth,
): string {
  const def = ICONS[name];
  if (!caps.unicode) return def.ascii;
  const expected = def.width ?? 1;
  return measure(def.unicode) === expected ? def.unicode : def.ascii;
}

export interface IconProps {
  name: IconName;
  /** Ink `<Text>` style (color + attrs) resolved from a token by the caller. */
  style?: InkTextStyle;
  /** Injected width oracle (boot probe); defaults to the built-in `stringWidth`. */
  measure?: (s: string) => number;
}

/** Render a capability-resolved, width-probed glyph. */
export function Icon({ name, style, measure }: IconProps): React.JSX.Element {
  const caps = useCaps();
  return <Text {...(style ?? {})}>{resolveIcon(name, caps, measure)}</Text>;
}
