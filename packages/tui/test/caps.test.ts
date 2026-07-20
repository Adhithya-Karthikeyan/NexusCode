import { describe, expect, it } from "vitest";
import { canMountTui, detectCapabilities, MIN_TUI_COLS, mountTui, toResolveCaps } from "../src/index.js";

const tty = { isTTY: true, columns: 120, rows: 40 };

describe("capability detection (§3.0)", () => {
  it("reads truecolor from COLORTERM", () => {
    const caps = detectCapabilities({ COLORTERM: "truecolor", TERM: "xterm-256color", LANG: "en_US.UTF-8" }, tty);
    expect(caps.truecolor).toBe(true);
    expect(caps.colors256).toBe(true);
    expect(caps.unicode).toBe(true);
    expect(caps.noColor).toBe(false);
  });

  it("honors NO_COLOR and forces mono", () => {
    const caps = detectCapabilities({ NO_COLOR: "1", COLORTERM: "truecolor" }, tty);
    expect(caps.noColor).toBe(true);
    expect(toResolveCaps(caps)).toEqual({ noColor: true });
  });

  it("TERM=dumb disables everything", () => {
    const caps = detectCapabilities({ TERM: "dumb" }, tty);
    expect(caps.termDumb).toBe(true);
    expect(caps.unicode).toBe(false);
  });
});

describe("mount guard (§2.8, hard rule 4)", () => {
  it("refuses a non-TTY with a graceful fallback", () => {
    const caps = detectCapabilities({ TERM: "xterm" }, { isTTY: false, columns: 120, rows: 40 });
    const decision = canMountTui(caps, {});
    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("non-tty");
    expect(decision.fallback).toContain("linear mode");
  });

  it("refuses TERM=dumb", () => {
    const caps = detectCapabilities({ TERM: "dumb" }, tty);
    expect(canMountTui(caps, {}).reason).toBe("term-dumb");
  });

  it(`refuses below ${MIN_TUI_COLS} columns`, () => {
    const caps = detectCapabilities({ TERM: "xterm" }, { isTTY: true, columns: 30, rows: 40 });
    expect(canMountTui(caps, {}).reason).toBe("too-narrow");
  });

  it("NEXUS_FORCE_TUI overrides the refusal", () => {
    const caps = detectCapabilities({ TERM: "xterm" }, { isTTY: false, columns: 30, rows: 40 });
    expect(canMountTui(caps, { NEXUS_FORCE_TUI: "1" }).ok).toBe(true);
  });

  it("mountTui writes the fallback and does not render on a non-TTY", () => {
    let out = "";
    const fakeStdout = { write: (s: string) => ((out += s), true) } as unknown as NodeJS.WriteStream;
    const result = mountTui({
      stdout: fakeStdout,
      env: { TERM: "xterm" },
      capabilities: detectCapabilities({ TERM: "xterm" }, { isTTY: false, columns: 120, rows: 40 }),
    });
    expect(result.mounted).toBe(false);
    expect(result.reason).toBe("non-tty");
    expect(out).toContain("linear mode");
    expect(result.instance).toBeUndefined();
  });
});
