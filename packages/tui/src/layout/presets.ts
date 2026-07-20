/**
 * Layout presets (design spec §2.1, §2.9). Each preset is a serialized pane tree
 * plus a responsive variant per width class. `chat` and `agent` default to
 * **Mode A** (scrollback); multi-panel `dashboard` uses **Mode B** (viewport) —
 * the frozen decision in §2.0. Switching preset only swaps trees; components stay
 * identity-stable so streaming never resets (§10.4-7).
 */

import type { BreakpointClass, LayoutPreset, PaneNode, PanelId, PresetId } from "./tree.js";
import { size } from "./tree.js";

let nodeSeq = 0;
function nid(prefix: string): string {
  nodeSeq += 1;
  return `${prefix}-${nodeSeq}`;
}

function leaf(panel: PanelId, sz = size(0, 1, 8), focusable = true): PaneNode {
  return { kind: "leaf", panel, id: nid(`leaf-${panel}`), size: sz, focusable };
}

function row(children: PaneNode[], sizes = children.map((_, i) => size(0, i === 0 ? 2 : 1, 20))): PaneNode {
  return { kind: "split", axis: "row", children, sizes, id: nid("row") };
}

function column(children: PaneNode[], sizes = children.map(() => size(0, 1, 3))): PaneNode {
  return { kind: "split", axis: "column", children, sizes, id: nid("col") };
}

function stack(children: PaneNode[], active = 0): PaneNode {
  return { kind: "stack", children, active, id: nid("stack") };
}

/** Build a preset whose narrow classes fall back to a single stacked column. */
function makeResponsive(
  perClass: Partial<Record<BreakpointClass, () => PaneNode>>,
  fallback: () => PaneNode,
): Record<BreakpointClass, PaneNode> {
  const classes: BreakpointClass[] = ["xnarrow", "narrow", "medium", "wide", "xwide"];
  const out = {} as Record<BreakpointClass, PaneNode>;
  for (const c of classes) out[c] = (perClass[c] ?? fallback)();
  return out;
}

/** CHAT (§2.9.1) — single-provider conversation + a thin right rail. Mode A. */
function chatPreset(): LayoutPreset {
  const single = (): PaneNode => leaf("conversation", size(0, 1, 8));
  const withRail = (): PaneNode =>
    row(
      [leaf("conversation", size(0, 3, 40)), stack([leaf("model_info", size(0, 1, 5)), leaf("notifications", size(0, 1, 3))])],
      [size(0, 3, 40), size(26, 1, 20)],
    );
  return {
    id: "chat",
    renderMode: "scrollback",
    root: withRail(),
    responsive: makeResponsive(
      { xnarrow: single, narrow: single, medium: withRail, wide: withRail, xwide: withRail },
      withRail,
    ),
    collapsePriority: ["notifications", "model_info"],
  };
}

/** AGENT (§2.9.2) — the densest coding preset: sidebar · conversation · diff over a dock. Mode A. */
function agentPreset(): LayoutPreset {
  const dock = (): PaneNode => stack([leaf("tool_activity", size(0, 1, 3)), leaf("tasks", size(0, 1, 3)), leaf("logs", size(0, 1, 3))]);
  const sidebar = (): PaneNode => stack([leaf("explorer", size(0, 1, 6)), leaf("plan", size(0, 1, 4))]);
  const single = (): PaneNode => column([leaf("conversation", size(0, 3, 8)), dock()], [size(0, 3, 8), size(0, 1, 3)]);
  const twoCol = (): PaneNode =>
    column(
      [row([sidebar(), leaf("conversation", size(0, 3, 40))], [size(24, 1, 20), size(0, 3, 40)]), dock()],
      [size(0, 3, 10), size(6, 1, 3)],
    );
  const threeCol = (): PaneNode =>
    column(
      [
        row(
          [sidebar(), leaf("conversation", size(0, 3, 40)), leaf("git_diff", size(0, 1, 30))],
          [size(22, 1, 18), size(0, 3, 40), size(28, 1, 24)],
        ),
        dock(),
      ],
      [size(0, 3, 10), size(6, 1, 3)],
    );
  return {
    id: "agent",
    renderMode: "scrollback",
    root: threeCol(),
    responsive: makeResponsive(
      { xnarrow: single, narrow: single, medium: twoCol, wide: threeCol, xwide: threeCol },
      threeCol,
    ),
    collapsePriority: ["logs", "tasks", "notifications", "git_diff", "explorer", "plan"],
  };
}

/**
 * COMPARE (§2.9.3) — the race grid. Mode B. Lanes are NOT panel leaves: they are
 * keyed by `UiEvent.lane` and rendered dynamically by `<CompareView>` from the
 * event stream (2–4 columns). The tree here is a single conversation leaf so the
 * focus ring / breakpoints stay valid; the actual column layout is data-driven.
 */
function comparePreset(): LayoutPreset {
  const single = (): PaneNode => leaf("conversation", size(0, 1, 8));
  return {
    id: "compare",
    renderMode: "viewport",
    root: single(),
    responsive: makeResponsive(
      { xnarrow: single, narrow: single, medium: single, wide: single, xwide: single },
      single,
    ),
    collapsePriority: [],
  };
}

/** DASHBOARD (§2.9.6) — all panels tiled in the alt-screen viewport. Mode B. */
function dashboardPreset(): LayoutPreset {
  const single = (): PaneNode => leaf("conversation", size(0, 1, 8));
  const full = (): PaneNode =>
    column(
      [
        row(
          [
            stack([leaf("explorer", size(0, 1, 6)), leaf("plan", size(0, 1, 4)), leaf("model_info", size(0, 1, 5))]),
            leaf("conversation", size(0, 3, 40)),
            stack([leaf("tasks", size(0, 1, 3)), leaf("notifications", size(0, 1, 3))]),
            stack([leaf("tool_activity", size(0, 1, 3)), leaf("git_diff", size(0, 1, 6)), leaf("logs", size(0, 1, 4))]),
          ],
          [size(22, 1, 18), size(0, 3, 40), size(24, 1, 18), size(24, 1, 18)],
        ),
      ],
      [size(0, 1, 8)],
    );
  return {
    id: "dashboard",
    renderMode: "viewport",
    root: full(),
    responsive: makeResponsive(
      { xnarrow: single, narrow: single, medium: full, wide: full, xwide: full },
      full,
    ),
    collapsePriority: ["logs", "tasks", "notifications", "tool_activity", "git_diff", "model_info", "explorer", "plan"],
  };
}

/** Build a fresh preset instance (nodes carry unique ids per build). */
export function buildPreset(id: PresetId): LayoutPreset {
  switch (id) {
    case "agent":
      return agentPreset();
    case "compare":
      return comparePreset();
    case "dashboard":
      return dashboardPreset();
    case "conversation":
    case "chat":
    case "plan":
    case "sessions":
    default:
      // `conversation` is rendered by the `<Conversation>` shell (not the pane
      // tree), but it still resolves to a valid preset so the focus ring /
      // breakpoints stay well-defined if the pane path is ever reached.
      return chatPreset();
  }
}

/**
 * The preset ids the `Ctrl+L` ring cycles + the palette lists. `conversation`
 * leads (it is the DEFAULT surface); `dashboard` stays reachable as the old
 * multi-pane preset.
 */
export const FOUNDATION_PRESETS: readonly PresetId[] = [
  "conversation",
  "chat",
  "agent",
  "compare",
  "dashboard",
];
