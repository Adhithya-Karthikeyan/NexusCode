import { describe, it, expect } from "vitest";
import {
  lintTheme,
  tokenContrast,
  wcagLevel,
  BUILTIN_THEME_LIST,
  BUILTIN_THEMES,
  WCAG_AA,
  WCAG_AAA,
  type NexusTheme,
} from "@nexuscode/theme";

describe("wcagLevel classification", () => {
  it("buckets ratios correctly", () => {
    expect(wcagLevel(21)).toBe("AAA");
    expect(wcagLevel(7)).toBe("AAA");
    expect(wcagLevel(4.5)).toBe("AA");
    expect(wcagLevel(3)).toBe("AA-large");
    expect(wcagLevel(2)).toBe("fail");
  });
});

describe("Contrast Max AAA passes AAA", () => {
  const theme = BUILTIN_THEMES["contrast-max"]!;

  it("declares an AAA floor", () => {
    expect(theme.meta.minContrast).toBe("AAA");
  });

  it("lints clean at its AAA floor", () => {
    const report = lintTheme(theme);
    expect(report.floor).toBe("AAA");
    expect(report.failures, JSON.stringify(report.failures, null, 2)).toHaveLength(0);
    expect(report.ok).toBe(true);
  });

  it("every text token clears 7:1 over surface.base", () => {
    for (const token of [
      "text.primary",
      "text.secondary",
      "text.muted",
      "accent.default",
      "success.fg",
      "warning.fg",
      "error.fg",
      "info.fg",
    ] as const) {
      const ratio = tokenContrast(theme, token);
      expect(ratio, `${token} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(WCAG_AAA);
    }
  });
});

describe("all themes pass their declared floor (AA for text)", () => {
  const themes: NexusTheme[] = BUILTIN_THEME_LIST as NexusTheme[];

  for (const theme of themes) {
    it(`${theme.meta.id} lints clean`, () => {
      const report = lintTheme(theme);
      expect(report.failures, JSON.stringify(report.failures, null, 2)).toHaveLength(0);
      expect(report.ok).toBe(true);
    });

    it(`${theme.meta.id} primary/secondary/muted clear AA`, () => {
      for (const token of ["text.primary", "text.secondary", "text.muted"] as const) {
        const ratio = tokenContrast(theme, token);
        expect(ratio, `${theme.meta.id} ${token} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(
          WCAG_AA,
        );
      }
    });
  }
});
