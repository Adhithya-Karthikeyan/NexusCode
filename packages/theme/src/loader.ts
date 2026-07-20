/**
 * Theme loader & registry (design spec §4.4, §4.8). Owns the built-in registry,
 * parses/validates user themes from the shareable JSON (`.nexustheme`) format
 * with Zod, dereferences `extends` + primitives, and enforces token completeness.
 * Filesystem access is isolated to `loadThemeFile` so the rest stays pure/testable.
 */

import { readFile } from "node:fs/promises";
import { TOKEN_IDS, type TokenId } from "./tokens.js";
import { ThemeFileSchema } from "./schema.js";
import { BUILTIN_THEMES, DEFAULT_THEME_ID } from "./themes/index.js";
import type { NexusTheme } from "./types.js";

export class ThemeValidationError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = "ThemeValidationError";
    this.issues = issues;
  }
}

/** A live registry: the built-ins plus any user/plugin themes registered at runtime. */
export class ThemeRegistry {
  private readonly themes = new Map<string, NexusTheme>();

  constructor(seed: Iterable<NexusTheme> = Object.values(BUILTIN_THEMES)) {
    for (const t of seed) this.themes.set(t.meta.id, t);
  }

  get(id: string): NexusTheme | undefined {
    return this.themes.get(id);
  }

  /** The default theme, guaranteed present (falls back to the first entry). */
  getDefault(): NexusTheme {
    return this.themes.get(DEFAULT_THEME_ID) ?? [...this.themes.values()][0]!;
  }

  has(id: string): boolean {
    return this.themes.has(id);
  }

  list(): NexusTheme[] {
    return [...this.themes.values()];
  }

  ids(): string[] {
    return [...this.themes.keys()];
  }

  register(theme: NexusTheme): void {
    this.themes.set(theme.meta.id, theme);
  }
}

/** A fresh registry pre-seeded with the 6 built-ins. */
export function createRegistry(): ThemeRegistry {
  return new ThemeRegistry();
}

function assertComplete(tokens: Record<string, string>, id: string): asserts tokens is Record<TokenId, string> {
  const missing = TOKEN_IDS.filter((t) => tokens[t] === undefined);
  if (missing.length > 0) {
    throw new ThemeValidationError(
      `theme "${id}" is missing ${missing.length} required token(s)`,
      missing.map((t) => `missing token: ${t}`),
    );
  }
}

/**
 * Validate + normalize a parsed theme object into a runtime `NexusTheme`.
 * Resolves `extends` (against a base registry) and enforces the full 74-token
 * set. Throws `ThemeValidationError` with structured issues on failure.
 */
export function parseTheme(
  input: unknown,
  opts: { base?: ThemeRegistry } = {},
): NexusTheme {
  const result = ThemeFileSchema.safeParse(input);
  if (!result.success) {
    throw new ThemeValidationError(
      "theme failed schema validation",
      result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`),
    );
  }
  const file = result.data;

  // Merge inherited tokens/primitives when `extends` is declared.
  let tokens: Record<string, string> = {};
  let primitives: Record<string, string> = {};
  if (file.meta.extends) {
    const base = (opts.base ?? new ThemeRegistry()).get(file.meta.extends);
    if (!base) {
      throw new ThemeValidationError(`theme "${file.meta.id}" extends unknown theme "${file.meta.extends}"`);
    }
    tokens = { ...base.tokens };
    primitives = { ...base.primitives };
  }
  primitives = { ...primitives, ...file.primitives };
  tokens = { ...tokens, ...file.tokens };

  assertComplete(tokens, file.meta.id);

  // Strip explicit `undefined`s that zod emits so the object satisfies
  // `exactOptionalPropertyTypes` on NexusThemeMeta.
  const meta = Object.fromEntries(
    Object.entries(file.meta).filter(([, v]) => v !== undefined),
  ) as unknown as NexusTheme["meta"];

  const theme: NexusTheme = {
    meta,
    primitives,
    tokens,
    ...(file.brand ? { brand: file.brand } : {}),
    ...(file.ansiFallback ? { ansiFallback: file.ansiFallback } : {}),
  };
  return theme;
}

/**
 * Load, parse, and validate a theme from a JSON file on disk. `extends` is
 * resolved against the built-in registry (plus any `opts.base`).
 */
export async function loadThemeFile(
  path: string,
  opts: { base?: ThemeRegistry } = {},
): Promise<NexusTheme> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new ThemeValidationError(`could not read theme file: ${path}`, [String(err)]);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ThemeValidationError(`theme file is not valid JSON: ${path}`, [String(err)]);
  }
  return parseTheme(json, opts);
}

/** Serialize a theme to the shareable JSON string (marketplace export, §4.8). */
export function exportTheme(theme: NexusTheme): string {
  const file: Record<string, unknown> = {
    meta: theme.meta,
    primitives: theme.primitives,
    tokens: theme.tokens,
    ...(theme.brand ? { brand: theme.brand } : {}),
    ...(theme.ansiFallback ? { ansiFallback: theme.ansiFallback } : {}),
  };
  return JSON.stringify(file, null, 2);
}
