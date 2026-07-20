/**
 * Mode B — alt-screen viewport render (design spec §2.0, §10.3). The TUI owns a
 * manual line-window viewport (`layout/viewport.ts`) instead of native scrollback:
 * the full pane tree renders into a bordered region whose height is `rows` minus
 * chrome. This foundation renders the tree directly; the cell-level repaint engine
 * layers on later, but the mode switch is clean — swapping the preset's render
 * mode swaps this view for `ScrollbackView` with identity-stable components (§10.4-7).
 */

import { Box } from "ink";
import { PaneRenderer, type PaneRenderContext } from "../layout/PaneRenderer.js";
import { useColor } from "../theme/ThemeProvider.js";
import { useCaps } from "../caps/CapabilityProvider.js";
import type { PaneNode } from "../layout/tree.js";

export interface ViewportViewProps {
  tree: PaneNode;
  ctx: PaneRenderContext;
  /** Rows available to the viewport (after chrome reservation). */
  rows: number;
}

export function ViewportView({ tree, ctx, rows }: ViewportViewProps): React.JSX.Element {
  const caps = useCaps();
  const border = useColor("chrome.border");
  const boxProps: Record<string, unknown> = {
    flexDirection: "column",
    flexGrow: 1,
    borderStyle: caps.unicode ? "round" : "single",
    minHeight: Math.max(1, rows),
  };
  if (border !== undefined) boxProps.borderColor = border;
  return (
    <Box {...boxProps}>
      <PaneRenderer node={tree} ctx={ctx} />
    </Box>
  );
}
