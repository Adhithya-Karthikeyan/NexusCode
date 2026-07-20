/**
 * Minimal glyph resolver (design spec §1.3.3, §3.0 `<Icon>`). Every glyph ships
 * an ASCII fallback; on a non-unicode terminal (`caps.unicode === false`, `--ascii`,
 * `TERM=dumb`) we downgrade. The full width-probing `<Icon>` component lands in a
 * later wave; this covers the fixed chrome/brand markers the foundation needs.
 */

import type { Capabilities } from "./capabilities.js";

/** Named single-cell markers used across chrome and panels. */
export type GlyphName =
  | "node" // brand diamond
  | "focus" // focused-title caret
  | "prompt" // input caret
  | "streaming" // in-flight spinner glyph
  | "ok"
  | "warn"
  | "error"
  | "running"
  | "bolt" // failover
  | "dotFilled" // active provider
  | "dotHollow" // available provider
  | "chevronRight"
  | "chevronDown"
  | "barFull"
  | "barEmpty"
  | "blocked" // plan task: blocked
  | "skipped"; // plan task: skipped

const UNICODE: Record<GlyphName, string> = {
  node: "◆",
  focus: "▸",
  prompt: "▸",
  streaming: "⟳",
  ok: "✓",
  warn: "⚠",
  error: "✗",
  running: "◴",
  bolt: "⚡",
  dotFilled: "●",
  dotHollow: "○",
  chevronRight: "▸",
  chevronDown: "▾",
  barFull: "▓",
  barEmpty: "░",
  blocked: "▲",
  skipped: "⊘",
};

const ASCII: Record<GlyphName, string> = {
  node: "*",
  focus: ">",
  prompt: ">",
  streaming: "~",
  ok: "v",
  warn: "!",
  error: "x",
  running: "o",
  bolt: "!",
  dotFilled: "*",
  dotHollow: "o",
  chevronRight: ">",
  chevronDown: "v",
  barFull: "#",
  barEmpty: "-",
  blocked: "!",
  skipped: "-",
};

/** Resolve a glyph for the current capabilities. */
export function glyph(caps: Pick<Capabilities, "unicode">, name: GlyphName): string {
  return caps.unicode ? UNICODE[name] : ASCII[name];
}
