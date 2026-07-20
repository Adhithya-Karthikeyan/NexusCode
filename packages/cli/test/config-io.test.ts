import { describe, it, expect } from "vitest";
import { setPath, getPath, validateUserConfig } from "../src/config-io.js";

describe("setPath — prototype pollution guard", () => {
  it("rejects __proto__ as an intermediate segment and does not pollute Object.prototype", () => {
    const obj: Record<string, unknown> = {};
    expect(() => setPath(obj, "__proto__.polluted", "evil")).toThrow(/invalid config key/);
    // The critical assertion: no other plain object in the process picked up `polluted`.
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype as unknown as Record<string, unknown>).not.toHaveProperty("polluted");
  });

  it("rejects __proto__ as the leaf segment", () => {
    const obj: Record<string, unknown> = {};
    expect(() => setPath(obj, "a.__proto__", "evil")).toThrow(/invalid config key/);
  });

  it("rejects constructor and prototype segments", () => {
    expect(() => setPath({}, "constructor.polluted", "evil")).toThrow(/invalid config key/);
    expect(() => setPath({}, "a.prototype.polluted", "evil")).toThrow(/invalid config key/);
  });

  it("keeps existing behavior for legitimate dotted keys", () => {
    const obj: Record<string, unknown> = {};
    setPath(obj, "tui.theme", "dark");
    expect(getPath(obj, "tui.theme")).toBe("dark");

    setPath(obj, "history.enabled", "false");
    expect(getPath(obj, "history.enabled")).toBe(false);

    setPath(obj, "defaultModel", "42");
    expect(getPath(obj, "defaultModel")).toBe(42);
  });

  it("reuses an existing intermediate object rather than clobbering it", () => {
    const obj: Record<string, unknown> = { tui: { theme: "light" } };
    setPath(obj, "tui.fontSize", "14");
    expect(getPath(obj, "tui.theme")).toBe("light");
    expect(getPath(obj, "tui.fontSize")).toBe(14);
  });
});

describe("validateUserConfig — pre-write schema gate", () => {
  it("rejects an unknown top-level key and names it plus the valid keys", () => {
    const obj: Record<string, unknown> = {};
    setPath(obj, "badkey.x", "y");
    const result = validateUserConfig(obj);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toMatch(/badkey/);
      expect(result.message).toMatch(/defaultProvider/);
    }
  });

  it("accepts a valid known key (defaultProvider)", () => {
    const obj: Record<string, unknown> = {};
    setPath(obj, "defaultProvider", "mock");
    expect(validateUserConfig(obj)).toEqual({ ok: true });
  });

  it("rejects a known key with a wrong-typed value", () => {
    const result = validateUserConfig({ approval: "not-a-valid-choice" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/approval/);
  });
});
