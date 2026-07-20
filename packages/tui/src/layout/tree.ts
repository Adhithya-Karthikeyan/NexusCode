/**
 * The pane-tree model (design spec §2.1). Everything on screen is a node in one
 * recursive tree; a layout is a serialized tree, so switching layout = swapping
 * the root, not rebuilding components (§10.4-7). The tree is **renderer-agnostic**
 * — the same `PaneNode` drives Mode A (scrollback) and Mode B (viewport).
 */

export type Axis = "row" | "column";

/** The 10 §22 panels. */
export type PanelId =
  | "conversation"
  | "explorer"
  | "tool_activity"
  | "plan"
  | "git_diff"
  | "logs"
  | "tasks"
  | "notifications"
  | "hud"
  | "model_info";

/** Flex sizing for a node (maps to Yoga `flexBasis`/`flexGrow`/`minWidth`). */
export interface Size {
  basis: number;
  grow: number;
  min: number;
  collapsedTo?: number;
}

export interface SplitNode {
  kind: "split";
  axis: Axis;
  children: PaneNode[];
  sizes: Size[];
  id: string;
}

export interface LeafNode {
  kind: "leaf";
  panel: PanelId;
  id: string;
  size: Size;
  focusable: boolean;
}

export interface StackNode {
  kind: "stack";
  children: PaneNode[];
  active: number;
  id: string;
}

export type PaneNode = SplitNode | LeafNode | StackNode;

/** Render mode of a preset — Mode A vs Mode B (§2.0). */
export type RenderMode = "scrollback" | "viewport";

/**
 * The layout presets (§2.1). `conversation` is the clean, Claude-Code-style DEFAULT
 * (a single scrolling transcript, rendered by the `<Conversation>` shell rather than
 * the pane tree); the multi-pane `dashboard`/`agent`/`compare`/`chat` presets remain
 * available and drive the `<Workspace>` pane machinery.
 */
export type PresetId =
  | "conversation"
  | "chat"
  | "agent"
  | "compare"
  | "plan"
  | "sessions"
  | "dashboard";

/** Responsive width classes (§2.8). */
export type BreakpointClass = "xnarrow" | "narrow" | "medium" | "wide" | "xwide";

export interface LayoutPreset {
  id: PresetId;
  renderMode: RenderMode;
  root: PaneNode;
  responsive: Record<BreakpointClass, PaneNode>;
  /** Lowest-priority panel collapses first under vertical/space pressure (§2.6). */
  collapsePriority: PanelId[];
}

/** The viewport a selector renders into. */
export interface Viewport {
  cols: number;
  rows: number;
}

/** Depth-first collection of every leaf node (reading order). */
export function collectLeaves(node: PaneNode): LeafNode[] {
  if (node.kind === "leaf") return [node];
  if (node.kind === "stack") {
    const child = node.children[node.active];
    return child ? collectLeaves(child) : [];
  }
  return node.children.flatMap(collectLeaves);
}

/** Find a node by id anywhere in the tree. */
export function findNode(node: PaneNode, id: string): PaneNode | null {
  if (node.id === id) return node;
  if (node.kind === "leaf") return null;
  for (const child of node.children) {
    const hit = findNode(child, id);
    if (hit) return hit;
  }
  return null;
}

/** Whether a leaf for the given panel exists in the tree (respects active stack). */
export function hasPanel(node: PaneNode, panel: PanelId): boolean {
  return collectLeaves(node).some((l) => l.panel === panel);
}

/** Convenience size factory. */
export function size(basis: number, grow: number, min: number, collapsedTo?: number): Size {
  return collapsedTo === undefined ? { basis, grow, min } : { basis, grow, min, collapsedTo };
}
