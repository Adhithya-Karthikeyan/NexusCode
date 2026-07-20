/**
 * @nexuscode/theme — the Theme Engine (TUI design spec §4–§5). Pure data +
 * resolver: it owns the semantic token layer, the 6 signature palettes, and the
 * per-token resolution pipeline (token → theme.tokens[id] → deref primitive →
 * capability gate → quantize → Color). It has **no dependency on ink or react** —
 * themes live entirely in the client, the engine never knows colors, so a theme
 * change is a client-only re-render with zero engine round-trips.
 */

/** Package identity marker. */
export const THEME_PACKAGE = "@nexuscode/theme" as const;

// Token registry (semantic layer).
export {
  TOKEN_IDS,
  TOKEN_ID_SET,
  PROVIDER_TOKENS,
  SYNTAX_TOKENS,
  BRAND_TOKEN_IDS,
  DEFAULT_TOKEN_ATTRS,
  type TokenId,
  type BrandTokenId,
  type TextAttr,
} from "./tokens.js";

// Color math.
export {
  parseHex,
  parseColorValue,
  rgbToHex,
  hslToRgb,
  relativeLuminance,
  contrastRatio,
  rgbToAnsi256,
  rgbToAnsi16,
  type Rgb,
  type Ansi16Name,
} from "./color.js";

// Types.
export type {
  ColorValue,
  ColorMode,
  ResolveCaps,
  ResolvedColor,
  NexusTheme,
  NexusThemeMeta,
  AnsiFallbackEntry,
} from "./types.js";

// Resolver.
export { resolveColor, createThemeResolver, inkColor } from "./resolve.js";

// Contrast checker & linter.
export {
  wcagLevel,
  tokenContrast,
  lintTheme,
  TEXT_ON_SURFACE_TOKENS,
  WCAG_AA,
  WCAG_AAA,
  WCAG_AA_LARGE,
  WCAG_NON_TEXT,
  type WcagLevel,
  type ContrastResult,
  type LintReport,
} from "./contrast.js";

// Schema.
export { ThemeFileSchema, ColorValueSchema, type ThemeFileInput, type ThemeFileParsed } from "./schema.js";

// Loader & registry.
export {
  ThemeRegistry,
  ThemeValidationError,
  createRegistry,
  parseTheme,
  loadThemeFile,
  exportTheme,
} from "./loader.js";

// Built-in signature themes.
export {
  BUILTIN_THEMES,
  BUILTIN_THEME_LIST,
  DEFAULT_THEME_ID,
  nexusNoir,
  paperNexus,
  solarFlare,
  glacier,
  contrastMax,
  synthwaveGrid,
  neon,
  midnight,
  vampire,
  retroAmber,
  pastel,
  frost,
  matrix,
  vivid,
  rose,
  forest,
} from "./themes/index.js";
