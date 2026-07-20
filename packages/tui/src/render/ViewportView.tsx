/**
 * Mode B — alt-screen viewport render (design spec §2.0, §10.3). The TUI owns a
 * manual line-window viewport (`layout/viewport.ts`) instead of native scrollback:
 * the full pane tree renders into a region whose height is `rows` minus chrome.
 *
 * There is deliberately **no border around the region**. Every pane inside it
 * already draws its own frame, so the outer box was a second border wrapping the
 * first — visible in the audit as `│╭────╮ ... ╰────╯│` — costing two columns,
 * two rows, and adding a nested-box look for no information. Panes are given
 * their exact rects instead, which is also what stops the tree overflowing the
 * terminal (dashboard used to run 15 columns past the right edge at 100 cols).
 */

import { Box } from "ink";
import { PaneRenderer, type PaneRenderContext } from "../layout/PaneRenderer.js";
import type { PaneNode } from "../layout/tree.js";

export interface ViewportViewProps {
  tree: PaneNode;
  ctx: PaneRenderContext;
  /** Rows available to the viewport (after chrome reservation). */
  rows: number;
  /** Columns available to the viewport. */
  cols?: number;
}

export function ViewportView({ tree, ctx, rows, cols }: ViewportViewProps): React.JSX.Element {
  return (
    <Box
      flexDirection="column"
      minHeight={Math.max(1, rows)}
      {...(cols ? { width: cols } : { flexGrow: 1 })}
    >
      <PaneRenderer node={tree} ctx={ctx} />
    </Box>
  );
}
