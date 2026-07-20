import { describe, expect, it } from "vitest";
import {
  buildPreset,
  classifyWidth,
  collectLeaves,
  computeLineWindow,
  deriveFocusRing,
  forcesCompactHud,
  hasPanel,
  nextFocus,
  prevFocus,
  reconcileFocus,
  scrollThumb,
  selectResponsiveTree,
} from "../src/index.js";

describe("breakpoints (§2.8)", () => {
  it("maps columns to width classes", () => {
    expect(classifyWidth(50)).toBe("xnarrow");
    expect(classifyWidth(80)).toBe("narrow");
    expect(classifyWidth(120)).toBe("medium");
    expect(classifyWidth(150)).toBe("wide");
    expect(classifyWidth(220)).toBe("xwide");
  });

  it("forces the compact HUD on narrow widths", () => {
    expect(forcesCompactHud("xnarrow")).toBe(true);
    expect(forcesCompactHud("narrow")).toBe(true);
    expect(forcesCompactHud("wide")).toBe(false);
  });
});

describe("presets (§2.1, §2.9)", () => {
  it("chat is Mode A, dashboard is Mode B", () => {
    expect(buildPreset("chat").renderMode).toBe("scrollback");
    expect(buildPreset("agent").renderMode).toBe("scrollback");
    expect(buildPreset("dashboard").renderMode).toBe("viewport");
  });

  it("chat collapses to a single conversation panel when narrow", () => {
    const chat = buildPreset("chat");
    const narrow = selectResponsiveTree(chat, 50);
    const wide = selectResponsiveTree(chat, 150);
    expect(collectLeaves(narrow).map((l) => l.panel)).toEqual(["conversation"]);
    expect(hasPanel(wide, "model_info")).toBe(true);
    expect(hasPanel(wide, "conversation")).toBe(true);
  });

  it("agent preset exposes sidebar + conversation + diff + dock when wide", () => {
    const agent = buildPreset("agent");
    const wide = selectResponsiveTree(agent, 150);
    const panels = collectLeaves(wide).map((l) => l.panel);
    expect(panels).toContain("conversation");
    expect(panels).toContain("git_diff");
    // The dock/sidebar are stacks — their active child shows.
    expect(panels).toContain("explorer");
    expect(panels).toContain("tool_activity");
  });

  it("responsive trees keep stable node ids across width changes (no churn)", () => {
    const chat = buildPreset("chat");
    const a = selectResponsiveTree(chat, 150);
    const b = selectResponsiveTree(chat, 150);
    expect(a).toBe(b); // same prebuilt node object
  });
});

describe("focus ring (§2.7)", () => {
  it("derives focusable leaves in reading order and navigates with wrap", () => {
    const wide = selectResponsiveTree(buildPreset("chat"), 150);
    const ring = deriveFocusRing(wide);
    expect(ring.length).toBeGreaterThanOrEqual(2);
    expect(nextFocus(ring, ring[0]!)).toBe(ring[1]);
    expect(nextFocus(ring, ring[ring.length - 1]!)).toBe(ring[0]); // wraps
    expect(prevFocus(ring, ring[0]!)).toBe(ring[ring.length - 1]);
  });

  it("reconciles a stale focus id to the first leaf after a resize", () => {
    const ring = ["a", "b", "c"];
    expect(reconcileFocus(ring, "b")).toBe("b");
    expect(reconcileFocus(ring, "gone")).toBe("a");
    expect(reconcileFocus([], "b")).toBeNull();
  });
});

describe("viewport engine (Mode B, §2.0)", () => {
  it("pins to the tail and clamps the offset", () => {
    expect(computeLineWindow(10, 5, 0)).toEqual({ start: 5, end: 10, offset: 0, overflow: true });
    expect(computeLineWindow(10, 5, 3)).toEqual({ start: 2, end: 7, offset: 3, overflow: true });
    expect(computeLineWindow(10, 5, 999)).toEqual({ start: 0, end: 5, offset: 5, overflow: true });
    expect(computeLineWindow(3, 5, 0)).toEqual({ start: 0, end: 3, offset: 0, overflow: false });
  });

  it("sizes the scrollbar thumb", () => {
    const thumb = scrollThumb(100, 10, 0);
    expect(thumb.size).toBeGreaterThanOrEqual(1);
    expect(thumb.size).toBeLessThanOrEqual(10);
  });
});
