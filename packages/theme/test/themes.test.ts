import { describe, it, expect } from "vitest";
import {
  BUILTIN_THEMES,
  BUILTIN_THEME_LIST,
  DEFAULT_THEME_ID,
  TOKEN_IDS,
  parseColorValue,
  createRegistry,
  type NexusTheme,
  type TokenId,
} from "@nexuscode/theme";

const SIGNATURE_IDS = [
  "nexus-noir",
  "paper-nexus",
  "solar-flare",
  "glacier",
  "contrast-max",
  "synthwave-grid",
];

const ADDITIONAL_IDS = [
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
];

const EXPECTED_IDS = [...SIGNATURE_IDS, ...ADDITIONAL_IDS];

describe("signature theme registry", () => {
  it("ships all 16 built-in themes", () => {
    expect(BUILTIN_THEME_LIST).toHaveLength(16);
    for (const id of EXPECTED_IDS) {
      expect(BUILTIN_THEMES[id]).toBeDefined();
    }
  });

  it("default is Nexus Noir (flagship dark)", () => {
    expect(DEFAULT_THEME_ID).toBe("nexus-noir");
    expect(BUILTIN_THEMES[DEFAULT_THEME_ID]!.meta.mode).toBe("dark");
  });

  it("Noir⇄Paper are OS-auto light/dark pair", () => {
    expect(BUILTIN_THEMES["nexus-noir"]!.meta.pairId).toBe("paper-nexus");
    expect(BUILTIN_THEMES["paper-nexus"]!.meta.pairId).toBe("nexus-noir");
    expect(BUILTIN_THEMES["paper-nexus"]!.meta.mode).toBe("light");
  });

  it("registry resolves every built-in by id", () => {
    const reg = createRegistry();
    for (const id of EXPECTED_IDS) expect(reg.get(id)?.meta.id).toBe(id);
    expect(reg.getDefault().meta.id).toBe("nexus-noir");
  });
});

describe("every theme is complete and valid", () => {
  const themes: NexusTheme[] = BUILTIN_THEME_LIST as NexusTheme[];

  for (const theme of themes) {
    describe(theme.meta.id, () => {
      it("defines all 74 required tokens", () => {
        for (const token of TOKEN_IDS) {
          expect(theme.tokens[token], `missing ${token}`).toBeDefined();
        }
        expect(Object.keys(theme.tokens).length).toBeGreaterThanOrEqual(TOKEN_IDS.length);
      });

      it("every token value is a parseable color", () => {
        for (const token of TOKEN_IDS) {
          const value = theme.tokens[token as TokenId]!;
          expect(parseColorValue(value, theme.primitives), `${token}=${value}`).not.toBeNull();
        }
      });

      it("derives brand tokens from the required set", () => {
        expect(theme.brand?.["brand.node"]).toBe(theme.tokens["accent.default"]);
        expect(theme.brand?.["brand.wordmark.fg"]).toBe(theme.tokens["text.primary"]);
      });
    });
  }
});
