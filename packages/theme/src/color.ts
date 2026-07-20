/**
 * Pure color math — no ink, no deps. Parsing (`#hex`/`rgb()`/`hsl()`/`@ref`),
 * WCAG relative luminance + contrast ratio, and quantization to the terminal's
 * real palette (xterm-256 cube + the 16 ANSI base colors). This is the
 * "quantize to terminal's real palette" step of the §4.1 resolution pipeline.
 */

/** An 8-bit-per-channel RGB triple. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** The 16 base ANSI color names (chalk/Ink spelling). */
export type Ansi16Name =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray"
  | "redBright"
  | "greenBright"
  | "yellowBright"
  | "blueBright"
  | "magentaBright"
  | "cyanBright"
  | "whiteBright";

const clamp8 = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));

/** Parse a `#rgb` / `#rrggbb` string. Returns `null` on malformed input. */
export function parseHex(input: string): Rgb | null {
  const s = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[0]!;
    const g = s[1]!;
    const b = s[2]!;
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
    };
  }
  if (/^[0-9a-fA-F]{6}$/.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }
  return null;
}

/** Serialize an RGB triple to a lowercase `#rrggbb` string. */
export function rgbToHex(rgb: Rgb): string {
  const h = (n: number): string => clamp8(n).toString(16).padStart(2, "0");
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}

/** Convert HSL (h ∈ [0,360), s/l ∈ [0,100]) to RGB. */
export function hslToRgb(h: number, s: number, l: number): Rgb {
  const sat = s / 100;
  const lig = l / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
  else if (hp < 2) [r1, g1, b1] = [x, c, 0];
  else if (hp < 3) [r1, g1, b1] = [0, c, x];
  else if (hp < 4) [r1, g1, b1] = [0, x, c];
  else if (hp < 5) [r1, g1, b1] = [x, 0, c];
  else [r1, g1, b1] = [c, 0, x];
  const m = lig - c / 2;
  return { r: clamp8((r1 + m) * 255), g: clamp8((g1 + m) * 255), b: clamp8((b1 + m) * 255) };
}

/**
 * Resolve any supported `ColorValue` string to an RGB triple. Handles `#hex`,
 * `rgb(r,g,b)`, `hsl(h,s%,l%)`, and `@primitiveRef` (deref via `primitives`).
 * Returns `null` when the value is unresolvable.
 */
export function parseColorValue(
  value: string,
  primitives: Record<string, string> = {},
  depth = 0,
): Rgb | null {
  if (depth > 16) return null; // ref cycle guard
  const v = value.trim();

  if (v.startsWith("@")) {
    const ref = primitives[v.slice(1)];
    return ref === undefined ? null : parseColorValue(ref, primitives, depth + 1);
  }
  if (v.startsWith("#")) return parseHex(v);

  const rgbM = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(v);
  if (rgbM) return { r: clamp8(+rgbM[1]!), g: clamp8(+rgbM[2]!), b: clamp8(+rgbM[3]!) };

  const hslM = /^hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)$/i.exec(v);
  if (hslM) return hslToRgb(+hslM[1]!, +hslM[2]!, +hslM[3]!);

  return null;
}

// ── WCAG contrast ────────────────────────────────────────────────────────────

function channelLuminance(c8: number): number {
  const c = c8 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance of an RGB triple (0 = black, 1 = white). */
export function relativeLuminance(rgb: Rgb): number {
  return (
    0.2126 * channelLuminance(rgb.r) +
    0.7152 * channelLuminance(rgb.g) +
    0.0722 * channelLuminance(rgb.b)
  );
}

function toRgb(c: Rgb | string): Rgb | null {
  return typeof c === "string" ? parseColorValue(c) : c;
}

/**
 * WCAG 2.1 contrast ratio between two colors, in `[1, 21]`. Order-independent.
 * Throws on an unparseable input so lint/tests fail loudly rather than silently.
 */
export function contrastRatio(a: Rgb | string, b: Rgb | string): number {
  const ra = toRgb(a);
  const rb = toRgb(b);
  if (!ra || !rb) throw new Error(`contrastRatio: unparseable color (${String(a)} / ${String(b)})`);
  const la = relativeLuminance(ra);
  const lb = relativeLuminance(rb);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// ── Quantization to the terminal palette ─────────────────────────────────────

/**
 * Quantize an RGB triple to the nearest xterm-256 index. Uses the 6×6×6 color
 * cube (16–231) and the 24-step grayscale ramp (232–255), picking whichever is
 * closer — the standard, well-tested mapping.
 */
export function rgbToAnsi256(rgb: Rgb): number {
  const { r, g, b } = rgb;

  // Candidate from the 6×6×6 color cube.
  const toCube = (v: number): number =>
    v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.round((v - 35) / 40));
  const ci = 16 + 36 * toCube(r) + 6 * toCube(g) + toCube(b);
  const cubeLevels = [0, 95, 135, 175, 215, 255];
  const cr = cubeLevels[toCube(r)]!;
  const cg = cubeLevels[toCube(g)]!;
  const cb = cubeLevels[toCube(b)]!;
  const cubeDist = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;

  // Candidate from the grayscale ramp.
  const avg = (r + g + b) / 3;
  let gi: number;
  if (avg < 8) gi = 16;
  else if (avg > 238) gi = 231;
  else gi = 232 + Math.round(((avg - 8) / 230) * 23);
  const gv = gi === 16 ? 0 : gi === 231 ? 255 : 8 + (gi - 232) * (230 / 23);
  const grayDist = (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2;

  return grayDist < cubeDist ? gi : ci;
}

const ANSI16_TABLE: ReadonlyArray<{ name: Ansi16Name; rgb: Rgb }> = [
  { name: "black", rgb: { r: 0, g: 0, b: 0 } },
  { name: "red", rgb: { r: 128, g: 0, b: 0 } },
  { name: "green", rgb: { r: 0, g: 128, b: 0 } },
  { name: "yellow", rgb: { r: 128, g: 128, b: 0 } },
  { name: "blue", rgb: { r: 0, g: 0, b: 128 } },
  { name: "magenta", rgb: { r: 128, g: 0, b: 128 } },
  { name: "cyan", rgb: { r: 0, g: 128, b: 128 } },
  { name: "white", rgb: { r: 192, g: 192, b: 192 } },
  { name: "gray", rgb: { r: 128, g: 128, b: 128 } },
  { name: "redBright", rgb: { r: 255, g: 0, b: 0 } },
  { name: "greenBright", rgb: { r: 0, g: 255, b: 0 } },
  { name: "yellowBright", rgb: { r: 255, g: 255, b: 0 } },
  { name: "blueBright", rgb: { r: 0, g: 0, b: 255 } },
  { name: "magentaBright", rgb: { r: 255, g: 0, b: 255 } },
  { name: "cyanBright", rgb: { r: 0, g: 255, b: 255 } },
  { name: "whiteBright", rgb: { r: 255, g: 255, b: 255 } },
];

/** Quantize an RGB triple to the nearest of the 16 base ANSI colors. */
export function rgbToAnsi16(rgb: Rgb): Ansi16Name {
  let best: Ansi16Name = "white";
  let bestDist = Infinity;
  for (const entry of ANSI16_TABLE) {
    const d =
      (rgb.r - entry.rgb.r) ** 2 + (rgb.g - entry.rgb.g) ** 2 + (rgb.b - entry.rgb.b) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = entry.name;
    }
  }
  return best;
}
