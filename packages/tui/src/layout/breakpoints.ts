/**
 * Breakpoints & the narrow-terminal contract (design spec §2.8). Maps a column
 * count to a width class and selects the matching responsive `PaneNode` from a
 * preset. Pure — fully unit-testable.
 */

import type { BreakpointClass, LayoutPreset, PaneNode } from "./tree.js";

/** Frozen breakpoint table (§2.8). `40` is the framed-layout minimum. */
export function classifyWidth(cols: number): BreakpointClass {
  if (cols < 60) return "xnarrow"; // 40–59 (below 40 the TUI refuses to mount)
  if (cols < 100) return "narrow"; // 60–99
  if (cols < 140) return "medium"; // 100–139
  if (cols < 200) return "wide"; // 140–199
  return "xwide"; // ≥200
}

/** Whether a class must force the HUD to its compact tier (§2.5, §2.8). */
export function forcesCompactHud(cls: BreakpointClass): boolean {
  return cls === "xnarrow" || cls === "narrow";
}

/** Below 24 rows, non-essential panels collapse and the HUD forces Tier 0 (§2.8). */
export function isShort(rows: number): boolean {
  return rows < 24;
}

/** Pick the responsive tree for the current width from a preset (§2.1). */
export function selectResponsiveTree(preset: LayoutPreset, cols: number): PaneNode {
  return preset.responsive[classifyWidth(cols)];
}
