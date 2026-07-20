import { describe, it, expect } from "vitest";
import {
  parseHex,
  parseColorValue,
  rgbToHex,
  hslToRgb,
  contrastRatio,
  relativeLuminance,
  rgbToAnsi256,
  rgbToAnsi16,
} from "@nexuscode/theme";

describe("color parsing", () => {
  it("parses 6- and 3-digit hex", () => {
    expect(parseHex("#0A0E14")).toEqual({ r: 10, g: 14, b: 20 });
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("nonsense")).toBeNull();
  });

  it("round-trips rgbToHex", () => {
    expect(rgbToHex({ r: 34, g: 211, b: 238 })).toBe("#22d3ee");
  });

  it("parses rgb() and hsl()", () => {
    expect(parseColorValue("rgb(34, 211, 238)")).toEqual({ r: 34, g: 211, b: 238 });
    const red = hslToRgb(0, 100, 50);
    expect(red).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseColorValue("hsl(0, 100%, 50%)")).toEqual({ r: 255, g: 0, b: 0 });
  });

  it("dereferences @primitive refs", () => {
    expect(parseColorValue("@cyan.400", { "cyan.400": "#22D3EE" })).toEqual({
      r: 34,
      g: 211,
      b: 238,
    });
    expect(parseColorValue("@missing", {})).toBeNull();
  });
});

describe("WCAG contrast", () => {
  it("black-on-white is 21:1", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
  });

  it("identical colors are 1:1", () => {
    expect(contrastRatio("#123456", "#123456")).toBeCloseTo(1, 5);
  });

  it("is order-independent", () => {
    const a = contrastRatio("#E6EDF3", "#0A0E14");
    const b = contrastRatio("#0A0E14", "#E6EDF3");
    expect(a).toBeCloseTo(b, 10);
  });

  it("luminance of white > black", () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255 })).toBeGreaterThan(
      relativeLuminance({ r: 0, g: 0, b: 0 }),
    );
  });

  it("throws on unparseable input", () => {
    expect(() => contrastRatio("not-a-color", "#000")).toThrow();
  });
});

describe("quantization", () => {
  it("maps pure colors to sensible ansi256 indices", () => {
    expect(rgbToAnsi256({ r: 0, g: 0, b: 0 })).toBe(16);
    expect(rgbToAnsi256({ r: 255, g: 255, b: 255 })).toBe(231);
    // mid-gray lands on the grayscale ramp (232-255), not the color cube
    expect(rgbToAnsi256({ r: 128, g: 128, b: 128 })).toBeGreaterThanOrEqual(232);
  });

  it("maps to nearest ansi16 name", () => {
    expect(rgbToAnsi16({ r: 255, g: 0, b: 0 })).toBe("redBright");
    expect(rgbToAnsi16({ r: 0, g: 0, b: 0 })).toBe("black");
    expect(rgbToAnsi16({ r: 34, g: 211, b: 238 })).toBe("cyanBright");
  });
});
