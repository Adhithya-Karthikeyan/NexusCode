import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseTheme,
  loadThemeFile,
  exportTheme,
  createRegistry,
  ThemeValidationError,
  nexusNoir,
  TOKEN_IDS,
} from "@nexuscode/theme";

/** A minimal, complete user theme (marketplace JSON shape). */
function fullThemeFile(id = "my-theme") {
  const tokens: Record<string, string> = {};
  for (const t of TOKEN_IDS) tokens[t] = "#808080";
  tokens["surface.base"] = "#000000";
  tokens["text.primary"] = "#FFFFFF";
  return {
    meta: { id, name: "My Theme", mode: "dark" as const },
    primitives: {},
    tokens,
  };
}

describe("parseTheme — validation", () => {
  it("accepts a complete, well-formed theme", () => {
    const theme = parseTheme(fullThemeFile());
    expect(theme.meta.id).toBe("my-theme");
    expect(Object.keys(theme.tokens)).toHaveLength(TOKEN_IDS.length);
  });

  it("rejects a theme missing required tokens", () => {
    const bad = fullThemeFile();
    delete (bad.tokens as Record<string, string>)["accent.default"];
    expect(() => parseTheme(bad)).toThrow(ThemeValidationError);
    try {
      parseTheme(bad);
    } catch (e) {
      expect((e as ThemeValidationError).issues.join()).toContain("accent.default");
    }
  });

  it("rejects an invalid color literal via zod", () => {
    const bad = fullThemeFile();
    bad.tokens["accent.default"] = "not-a-color";
    expect(() => parseTheme(bad)).toThrow(ThemeValidationError);
  });

  it("rejects an unknown token id via zod", () => {
    const bad = fullThemeFile() as { tokens: Record<string, string> };
    bad.tokens["totally.made.up"] = "#123456";
    expect(() => parseTheme(bad)).toThrow(ThemeValidationError);
  });

  it("resolves @primitive refs against declared primitives", () => {
    const file = fullThemeFile("prim-theme");
    file.primitives = { brandCyan: "#22D3EE" };
    file.tokens["accent.default"] = "@brandCyan";
    const theme = parseTheme(file);
    expect(theme.tokens["accent.default"]).toBe("@brandCyan");
    expect(theme.primitives["brandCyan"]).toBe("#22D3EE");
  });

  it("supports extends: inherit then overlay", () => {
    const partial = {
      meta: { id: "noir-tweak", name: "Noir Tweak", mode: "dark" as const, extends: "nexus-noir" },
      tokens: { "accent.default": "#FF00FF" },
    };
    const theme = parseTheme(partial, { base: createRegistry() });
    expect(theme.tokens["accent.default"]).toBe("#FF00FF");
    // inherited from Noir:
    expect(theme.tokens["surface.base"]).toBe(nexusNoir.tokens["surface.base"]);
  });

  it("throws when extends targets an unknown theme", () => {
    const partial = {
      meta: { id: "x", name: "x", mode: "dark" as const, extends: "does-not-exist" },
      tokens: {},
    };
    expect(() => parseTheme(partial, { base: createRegistry() })).toThrow(ThemeValidationError);
  });
});

describe("loadThemeFile — from disk (marketplace JSON)", () => {
  it("reads, parses, and validates a JSON theme file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-theme-"));
    try {
      const path = join(dir, "my-theme.nexustheme.json");
      await writeFile(path, JSON.stringify(fullThemeFile("disk-theme")), "utf8");
      const theme = await loadThemeFile(path);
      expect(theme.meta.id).toBe("disk-theme");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips through exportTheme → parseTheme", () => {
    const json = exportTheme(nexusNoir);
    const back = parseTheme(JSON.parse(json));
    expect(back.meta.id).toBe("nexus-noir");
    expect(back.tokens["accent.default"]).toBe(nexusNoir.tokens["accent.default"]);
  });

  it("raises ThemeValidationError on malformed JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-theme-"));
    try {
      const path = join(dir, "broken.json");
      await writeFile(path, "{ not json", "utf8");
      await expect(loadThemeFile(path)).rejects.toThrow(ThemeValidationError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("registry", () => {
  it("lists all built-ins and can register a new theme", () => {
    const reg = createRegistry();
    expect(reg.ids()).toContain("nexus-noir");
    expect(reg.list().length).toBeGreaterThanOrEqual(6);
    reg.register(parseTheme(fullThemeFile("added")));
    expect(reg.has("added")).toBe(true);
  });
});
