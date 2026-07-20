/**
 * `<PaneSplit>` (design spec §2.1) — renders a `split` node as an Ink `<Box>`
 * whose `flexDirection` follows the split axis.
 *
 * Widths are **not** negotiated with Yoga: `layout/measure.ts` has already
 * resolved every child to an exact integer rect, and each child box is pinned to
 * it (`width`/`height` + `flexShrink: 0`). That is what keeps a long title or a
 * wide code line from widening its pane past the terminal edge, which is how the
 * ragged `││` seams and the 115-column overflow at 100 columns happened.
 *
 * The single blank column between side-by-side panes is the measurement's
 * `PANE_GAP`, so the gap is budgeted rather than added on afterwards.
 */

import { Box } from "ink";
import { isVisible } from "./measure.js";
import { PaneRenderer, boxSize, type PaneRenderContext } from "./PaneRenderer.js";
import type { SplitNode } from "./tree.js";

export function PaneSplit({
  node,
  ctx,
}: {
  node: SplitNode;
  ctx: PaneRenderContext;
}): React.JSX.Element {
  const isRow = node.axis === "row";
  const own = ctx.layout?.get(node.id);

  return (
    <Box
      flexDirection={isRow ? "row" : "column"}
      {...(isRow ? { gap: 1 } : {})}
      {...(own ? { ...boxSize(ctx, own), flexShrink: 0 } : { flexGrow: 1 })}
    >
      {node.children.map((child) => {
        const rect = ctx.layout?.get(child.id);
        if (ctx.layout && !isVisible(rect)) return null;
        return (
          <Box
            key={child.id}
            flexDirection="column"
            {...(rect
              ? { ...boxSize(ctx, rect), flexShrink: 0 }
              : { flexGrow: 1, flexShrink: 1 })}
          >
            <PaneRenderer node={child} ctx={ctx} />
          </Box>
        );
      })}
    </Box>
  );
}
