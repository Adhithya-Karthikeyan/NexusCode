/**
 * Lane metadata: the single source of truth for prefix ordering, cache posture,
 * and human-readable section titles. STATIC lanes come first (cacheable prefix),
 * VOLATILE lanes last (trimmed tail).
 */

import { CONTEXT_LANES, type ContextKind, type ContextLane } from "./types.js";

interface LaneMeta {
  index: number;
  kind: ContextKind;
  title: string;
}

export const LANE_TABLE: Record<ContextLane, LaneMeta> = {
  system: { index: 0, kind: "static", title: "System" },
  tools: { index: 1, kind: "static", title: "Tools" },
  memory: { index: 2, kind: "static", title: "Memory" },
  conventions: { index: 3, kind: "static", title: "Project Conventions" },
  "repo-map": { index: 4, kind: "static", title: "Project Files" },
  env: { index: 5, kind: "static", title: "Environment" },
  retrieved: { index: 6, kind: "volatile", title: "Retrieved" },
  git: { index: 7, kind: "volatile", title: "Working Changes" },
  history: { index: 8, kind: "volatile", title: "Conversation" },
  terminal: { index: 9, kind: "volatile", title: "Terminal Output" },
  task: { index: 10, kind: "volatile", title: "Current Task" },
};

export function laneIndex(lane: ContextLane): number {
  return LANE_TABLE[lane].index;
}

export function laneKind(lane: ContextLane): ContextKind {
  return LANE_TABLE[lane].kind;
}

export function laneTitle(lane: ContextLane): string {
  return LANE_TABLE[lane].title;
}

export function isStatic(lane: ContextLane): boolean {
  return LANE_TABLE[lane].kind === "static";
}

/** Static lanes, in prefix order. */
export const STATIC_LANES: readonly ContextLane[] = CONTEXT_LANES.filter(isStatic);

/** Volatile lanes, in prefix order (tail region). */
export const VOLATILE_LANES: readonly ContextLane[] = CONTEXT_LANES.filter((l) => !isStatic(l));
