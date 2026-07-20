/**
 * `<PaneSplit>` (design spec §2.1) — renders a `split` node as an Ink `<Box>`
 * whose `flexDirection` follows the split axis, injecting a `<Splitter>` between
 * children. Ratios come from each child's `Size` (`flexBasis`/`flexGrow`/`minWidth`),
 * so Yoga resolves the geometry (§2.1: "Yoga resolves the rest").
 */

import { Box } from "ink";
import { PaneRenderer, type PaneRenderContext } from "./PaneRenderer.js";
import type { Size, SplitNode } from "./tree.js";

function boxSizing(axis: SplitNode["axis"], sz: Size | undefined): Record<string, number> {
  const s = sz ?? { basis: 0, grow: 1, min: 0 };
  const props: Record<string, number> = { flexGrow: s.grow, flexShrink: 1, flexBasis: s.basis };
  // Along a row the constraint is width; along a column it is height.
  if (axis === "row") props.minWidth = s.min;
  else props.minHeight = s.min;
  return props;
}

export function PaneSplit({
  node,
  ctx,
}: {
  node: SplitNode;
  ctx: PaneRenderContext;
}): React.JSX.Element {
  const isRow = node.axis === "row";
  // The panes' own borders already separate them; we add a single blank column
  // of breathing room between side-by-side panes (a `gap`) rather than a stray
  // 1-cell `<Splitter>` glyph that used to float unaligned in the seam. Stacked
  // (column) panes need no gap — their top/bottom borders meet cleanly.
  return (
    <Box flexDirection={isRow ? "row" : "column"} flexGrow={1} {...(isRow ? { gap: 1 } : {})}>
      {node.children.map((child, i) => (
        <Box key={child.id} {...boxSizing(node.axis, node.sizes[i])} flexDirection="column">
          <PaneRenderer node={child} ctx={ctx} />
        </Box>
      ))}
    </Box>
  );
}
