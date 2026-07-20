import { describe, it, expect } from "vitest";
import {
  BUILTIN_THEMES,
  TOKEN_IDS,
  TEXT_ON_SURFACE_TOKENS,
  WCAG_AA,
  lintTheme,
  tokenContrast,
  parseColorValue,
  type NexusTheme,
  type TokenId,
} from "@nexuscode/theme";

/** The 10 additional community-inspired dark themes added on top of the 6 signature palettes. */
const NEW_THEME_IDS = [
  "neon",
  "midnight",
  "vampire",
  "retro-amber",
  "pastel",
  "frost",
  "matrix",
  "vivid",
  "rose",
  "forest",
] as const;

describe("10 additional themes are registered", () => {
  it("every new id resolves to a theme with matching meta.id and dark mode", () => {
    for (const id of NEW_THEME_IDS) {
      const theme = BUILTIN_THEMES[id];
      expect(theme, `missing theme ${id}`).toBeDefined();
      expect(theme!.meta.id).toBe(id);
      expect(theme!.meta.mode).toBe("dark");
    }
  });
});

describe("each new theme is complete, parseable, and AA-readable", () => {
  for (const id of NEW_THEME_IDS) {
    const theme = BUILTIN_THEMES[id] as NexusTheme;

    describe(id, () => {
      it("defines all 74 required tokens", () => {
        for (const token of TOKEN_IDS) {
          expect(theme.tokens[token], `missing ${token}`).toBeDefined();
        }
      });

      it("resolves every token to a parseable color", () => {
        for (const token of TOKEN_IDS) {
          const value = theme.tokens[token as TokenId]!;
          expect(parseColorValue(value, theme.primitives), `${token}=${value}`).not.toBeNull();
        }
      });

      it("every text token clears WCAG AA against surface.base", () => {
        for (const token of TEXT_ON_SURFACE_TOKENS) {
          const ratio = tokenContrast(theme, token, "surface.base");
          expect(ratio, `${id}: ${token} ratio ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(WCAG_AA);
        }
      });

      it("passes the full theme lint (text + diff pairs, no failures)", () => {
        const report = lintTheme(theme);
        expect(report.failures, JSON.stringify(report.failures)).toHaveLength(0);
        expect(report.ok).toBe(true);
      });

      it("derives brand tokens from the required set", () => {
        expect(theme.brand?.["brand.node"]).toBe(theme.tokens["accent.default"]);
        expect(theme.brand?.["brand.wordmark.fg"]).toBe(theme.tokens["text.primary"]);
      });
    });
  }
});
