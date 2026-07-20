/**
 * `<PaneRenderer>` — the recursive dispatcher that turns a `PaneNode` into Ink
 * elements (design spec §2.1). A `split` → `<PaneSplit>`, a `stack` →
 * `<PaneStack>`, a `leaf` → `<PaneFrame>` wrapping the panel's selector body.
 * The same renderer drives both render modes; `mode` only changes what the
 * conversation leaf shows (live tail vs. full history, §2.0).
 */

import { useCaps } from "../caps/CapabilityProvider.js";
import { PanelBody, panelRailSummary, panelTitle, isEssentialPanel } from "../panels/panels.js";
import type { ViewState } from "../store/viewState.js";
import { PaneFrame } from "./PaneFrame.js";
import { PaneSplit } from "./PaneSplit.js";
import { PaneStack } from "./PaneStack.js";
import type { PaneNode, RenderMode } from "./tree.js";

export interface PaneRenderContext {
  view: ViewState;
  focusedId: string | null;
  collapsedIds: ReadonlySet<string>;
  mode: RenderMode;
}

export function PaneRenderer({
  node,
  ctx,
}: {
  node: PaneNode;
  ctx: PaneRenderContext;
}): React.JSX.Element {
  const caps = useCaps();

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
    >
      <PanelBody panel={node.panel} v={ctx.view} mode={ctx.mode} />
    </PaneFrame>
  );
}
