import { describe, it, expect } from "vitest";
import {
  resolveColor,
  createThemeResolver,
  inkColor,
  nexusNoir,
  type ResolveCaps,
} from "@nexuscode/theme";

const TRUECOLOR: ResolveCaps = { truecolor: true };
const C256: ResolveCaps = { colors256: true };
const C16: ResolveCaps = {};
const MONO: ResolveCaps = { noColor: true };

describe("resolveColor — capability gating", () => {
  it("truecolor keeps the exact hex", () => {
    const r = resolveColor(nexusNoir, "accent.default", TRUECOLOR);
    expect(r.mode).toBe("truecolor");
    expect(r.hex).toBe("#22d3ee");
    expect(inkColor(r)).toBe("#22d3ee");
  });

  it("256-color quantizes to an index", () => {
    const r = resolveColor(nexusNoir, "accent.default", C256);
    expect(r.mode).toBe("ansi256");
    expect(typeof r.ansi256).toBe("number");
    expect(inkColor(r)).toBe(r.ansi256);
  });

  it("16-color maps to an ansi name", () => {
    const r = resolveColor(nexusNoir, "accent.default", C16);
    expect(r.mode).toBe("ansi16");
    expect(r.ansi16).toBe("cyanBright");
    expect(inkColor(r)).toBe("cyanBright");
  });

  it("no-color/monochrome returns attributes, not colors", () => {
    const r = resolveColor(nexusNoir, "text.primary", MONO);
    expect(r.mode).toBe("mono");
    expect(r.hex).toBeUndefined();
    expect(r.ansi256).toBeUndefined();
    expect(r.ansi16).toBeUndefined();
    expect(inkColor(r)).toBeUndefined();
    // primary carries a bold attr so it survives with no color
    expect(r.attrs).toContain("bold");
  });
});

describe("resolveColor — redundant attributes (color never load-bearing)", () => {
  it("diff add underlines, diff remove strikes, invalid bolds, focus reverses", () => {
    expect(resolveColor(nexusNoir, "diff.added.fg", MONO).attrs).toContain("underline");
    expect(resolveColor(nexusNoir, "diff.removed.fg", MONO).attrs).toContain("strikethrough");
    expect(resolveColor(nexusNoir, "syntax.invalid", MONO).attrs).toContain("bold");
    expect(resolveColor(nexusNoir, "focus.ring", MONO).attrs).toContain("reverse");
    expect(resolveColor(nexusNoir, "text.muted", TRUECOLOR).attrs).toContain("dim");
  });
});

describe("createThemeResolver — memoization", () => {
  it("returns a stable resolved object for repeat lookups", () => {
    const resolve = createThemeResolver(nexusNoir, TRUECOLOR);
    const a = resolve("accent.default");
    const b = resolve("accent.default");
    expect(a).toBe(b); // identity-stable (cached)
    expect(a.hex).toBe("#22d3ee");
  });

  it("caches per capability, not globally", () => {
    const tc = createThemeResolver(nexusNoir, TRUECOLOR)("accent.default");
    const mono = createThemeResolver(nexusNoir, MONO)("accent.default");
    expect(tc.mode).toBe("truecolor");
    expect(mono.mode).toBe("mono");
  });
});
