import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseArgs, type FlagSpec } from "../src/args.js";

const SPEC: FlagSpec = {
  value: { model: ["m"], provider: ["p"], output: ["o"] },
  multi: { backend: ["b"] },
  bool: { help: ["h"], tools: ["t"] },
};

describe("parseArgs", () => {
  it("parses known value/multi/bool flags and positionals as before", () => {
    const args = parseArgs(["ask", "-p", "mock", "-m", "sonnet", "hi there"], SPEC);
    expect(args.flags.get("provider")).toBe("mock");
    expect(args.flags.get("model")).toBe("sonnet");
    expect(args.positionals).toEqual(["ask", "hi there"]);
    expect(args.unknown).toEqual([]);
  });

  it("reports no unknown flags for a fully recognized invocation", () => {
    const args = parseArgs(["-p", "mock", "-o", "json", "--tools"], SPEC);
    expect(args.unknown).toEqual([]);
  });

  describe("unknown-flag detection + warning (FIX 3: typo'd flags must be visible, not silently dropped)", () => {
    let stderrSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });
    afterEach(() => {
      stderrSpy.mockRestore();
    });

    it("collects an unrecognized --flag into `unknown`", () => {
      const args = parseArgs(["--modle", "gpt-4"], SPEC);
      expect(args.unknown).toEqual(["--modle"]);
    });

    it("prints a warning to stderr naming the unknown flag with a did-you-mean suggestion", () => {
      parseArgs(["--modle", "gpt-4"], SPEC);
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const printed = String(stderrSpy.mock.calls[0]?.[0]);
      expect(printed).toMatch(/warning: unknown flag\(s\) ignored:/);
      expect(printed).toContain("--modle");
      expect(printed).toMatch(/did you mean --model\?/);
    });

    it("still parses the typo'd token as a harmless boolean (no hard error, unchanged prior behavior)", () => {
      const args = parseArgs(["--modle", "gpt-4"], SPEC);
      expect(args.bools.has("modle")).toBe(true);
    });

    it("does not warn when every flag is recognized", () => {
      parseArgs(["-p", "mock", "hi"], SPEC);
      expect(stderrSpy).not.toHaveBeenCalled();
    });

    it("collects multiple unknown flags in one warning", () => {
      const args = parseArgs(["--modle", "gpt", "--outut", "json"], SPEC);
      expect(args.unknown).toEqual(["--modle", "--outut"]);
      const printed = String(stderrSpy.mock.calls[0]?.[0]);
      expect(printed).toContain("--modle");
      expect(printed).toContain("--outut");
    });

    it("omits a did-you-mean suggestion when nothing is close enough", () => {
      const args = parseArgs(["--xyzzyplugh"], SPEC);
      expect(args.unknown).toEqual(["--xyzzyplugh"]);
      const printed = String(stderrSpy.mock.calls[0]?.[0]);
      expect(printed).toContain("--xyzzyplugh");
      expect(printed).not.toMatch(/did you mean/);
    });
  });
});
