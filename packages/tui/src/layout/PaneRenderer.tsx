/**
 * `<PaneRenderer>` — the recursive dispatcher that turns a `PaneNode` into Ink
 * elements (design spec §2.1). A `split` → `<PaneSplit>`, a `stack` →
 * `<PaneStack>`, a `leaf` → `<PaneFrame>` wrapping the panel's selector body.
 * The same renderer drives both render modes; `mode` only changes what the
 * conversation leaf shows (live tail vs. full history, §2.0).
 *
 * Geometry comes from `ctx.layout` (see `layout/measure.ts`) — every pane is
 * handed an exact rect rather than left to flex, and a pane the measurement
 * dropped (zero rect) renders nothing at all instead of a squeezed sliver.
 */

import { useCaps } from "../caps/CapabilityProvider.js";
import { PanelBody, panelRailSummary, panelTitle, isEssentialPanel } from "../panels/panels.js";
import type { ViewState } from "../store/viewState.js";
import { isVisible, type LayoutMap, type Rect, PANE_CHROME_X, PANE_CHROME_Y } from "./measure.js";
import { PaneFrame } from "./PaneFrame.js";
import { PaneSplit } from "./PaneSplit.js";
import { PaneStack } from "./PaneStack.js";
import type { PaneNode, RenderMode } from "./tree.js";

export interface PaneRenderContext {
  view: ViewState;
  focusedId: string | null;
  collapsedIds: ReadonlySet<string>;
  mode: RenderMode;
  /** Exact rects for every node, from `layoutTree`. Absent → unconstrained. */
  layout?: LayoutMap;
  /**
   * Whether panes are pinned to the measured **height** as well as the width.
   *
   * True in Mode B, where the viewport owns a fixed region and panes tile it.
   * False in Mode A, where the transcript above already fills the screen and a
   * pane holds only the live tail — pinning height there produced the audit's
   * worst offender: a `Conversation` box containing one line of text followed by
   * seventeen blank rows, on an 80×24 terminal. Widths stay pinned either way,
   * because that is what keeps content inside the terminal.
   */
  fitHeight?: boolean;
}

/** The rect a node was allotted, if the context carries a measurement. */
export function useRect(ctx: PaneRenderContext, id: string): Rect | undefined {
  return ctx.layout?.get(id);
}

/**
 * Geometry props for a measured `<PaneFrame>`: always a width, height only in
 * Mode B (the frame turns that height into a `minHeight` — see PaneFrame).
 */
export function sizeProps(
  ctx: PaneRenderContext,
  rect: Rect | undefined,
): { width?: number; height?: number } {
  if (!rect) return {};
  return ctx.fitHeight ? { width: rect.width, height: rect.height } : { width: rect.width };
}

/**
 * The same geometry for a plain Ink `<Box>` wrapper. `minHeight`, never
 * `height`: a fixed height on a Box whose content is taller does not clip in
 * Ink, it overlays the surplus rows and corrupts the text.
 */
export function boxSize(
  ctx: PaneRenderContext,
  rect: Rect | undefined,
): { width?: number; minHeight?: number } {
  if (!rect) return {};
  return ctx.fitHeight ? { width: rect.width, minHeight: rect.height } : { width: rect.width };
}

export function PaneRenderer({
  node,
  ctx,
}: {
  node: PaneNode;
  ctx: PaneRenderContext;
}): React.JSX.Element | null {
  const caps = useCaps();
  const rect = ctx.layout?.get(node.id);

  // Measured out of existence (the terminal could not seat it) — render nothing
  // rather than a 3-column stub with a mangled border.
  if (ctx.layout && !isVisible(rect)) return null;

  if (node.kind === "split") {
    return <PaneSplit node={node} ctx={ctx} />;
  }
  if (node.kind === "stack") {
    return <PaneStack node={node} ctx={ctx} />;
  }

  const collapsed = ctx.collapsedIds.has(node.id) && !isEssentialPanel(node.panel, caps);
  return (
    <PaneFrame
      title={panelTitle(node.panel, ctx.view)}
      focused={ctx.focusedId === node.id}
      collapsed={collapsed}
      collapsible={node.focusable}
      railSummary={panelRailSummary(node.panel, ctx.view)}
      {...sizeProps(ctx, rect)}
    >
      <PanelBody
        panel={node.panel}
        v={ctx.view}
        mode={ctx.mode}
        {...(rect ? { width: Math.max(1, rect.width - PANE_CHROME_X) } : {})}
        {...(rect && ctx.fitHeight ? { maxRows: Math.max(1, rect.height - PANE_CHROME_Y) } : {})}
      />
    </PaneFrame>
  );
}
