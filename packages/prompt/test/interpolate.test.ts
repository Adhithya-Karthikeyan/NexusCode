import { describe, it, expect } from "vitest";
import { interpolate, referencedVars } from "@nexuscode/prompt";
import { NexusError } from "@nexuscode/shared";

describe("interpolate", () => {
  it("substitutes simple and whitespace-padded placeholders", () => {
    expect(interpolate("Hello {{name}}!", { name: "Ada" })).toBe("Hello Ada!");
    expect(interpolate("Hello {{  name  }}!", { name: "Ada" })).toBe("Hello Ada!");
  });

  it("resolves dotted paths into nested objects", () => {
    expect(interpolate("{{user.profile.city}}", { user: { profile: { city: "Paris" } } })).toBe(
      "Paris",
    );
  });

  it("stringifies numbers, booleans, and objects deterministically", () => {
    expect(interpolate("{{n}}", { n: 42 })).toBe("42");
    expect(interpolate("{{b}}", { b: false })).toBe("false");
    // Object keys are sorted regardless of insertion order.
    const a = interpolate("{{o}}", { o: { b: 1, a: 2 } });
    const b = interpolate("{{o}}", { o: { a: 2, b: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1}');
  });

  it("does not re-expand placeholders that appear inside a substituted value (injection guard)", () => {
    expect(interpolate("{{x}}", { x: "{{y}}", y: "SECRET" })).toBe("{{y}}");
  });

  it("never evaluates expressions — only exact variable names are matched", () => {
    // An expression-y placeholder is not a valid name, so it is left untouched.
    expect(interpolate("{{1 + 1}}", {})).toBe("{{1 + 1}}");
    expect(interpolate("{{ constructor }}", {}, "keep")).toBe("{{ constructor }}");
  });

  it("throws on a missing variable by default", () => {
    expect(() => interpolate("Hi {{missing}}", {})).toThrow(NexusError);
    expect(() => interpolate("Hi {{missing}}", {})).toThrow(/missing/);
  });

  it("honors empty and keep missing-var behaviors", () => {
    expect(interpolate("Hi {{missing}}.", {}, "empty")).toBe("Hi .");
    expect(interpolate("Hi {{missing}}.", {}, "keep")).toBe("Hi {{missing}}.");
  });

  it("treats null the same as missing", () => {
    expect(() => interpolate("{{x}}", { x: null })).toThrow();
    expect(interpolate("{{x}}", { x: null }, "empty")).toBe("");
  });

  it("lists referenced variables uniquely and sorted", () => {
    expect(referencedVars("{{b}} {{a}} {{b}} {{a.c}}")).toEqual(["a", "a.c", "b"]);
    expect(referencedVars("no vars here")).toEqual([]);
  });
});
