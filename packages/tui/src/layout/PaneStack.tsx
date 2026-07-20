/**
 * `<PaneStack>` (design spec §2.1, §2.6) — the tabbed dock. A `stack` node holds
 * N children but shows one; a header tab-strip (`[Tool Activity][Logs][Tasks]`)
 * marks the active child, cycled with `Ctrl+]`. Only the active child renders.
 *
 * The whole dock lives in ONE `<PaneFrame>` whose title bar IS the tab strip, so
 * the tabs sit *inside* the border (aligned with the pane) instead of floating as
 * raw text above it. When the active child is a leaf we render its selector body
 * directly (no nested second frame); a nested split still recurses.
 */

import { Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { collectLeaves, type StackNode } from "./tree.js";
import { isEssentialPanel, PanelBody, panelRailSummary, panelTitle } from "../panels/panels.js";
import { PaneFrame } from "./PaneFrame.js";
import { PaneRenderer, type PaneRenderContext } from "./PaneRenderer.js";
import { useTextStyle } from "../theme/ThemeProvider.js";

function tabLabel(node: StackNode["children"][number], view: PaneRenderContext["view"]): string {
  const leaves = collectLeaves(node);
  const first = leaves[0];
  return first ? panelTitle(first.panel, view) : node.id;
}

export function PaneStack({
  node,
  ctx,
}: {
  node: StackNode;
  ctx: PaneRenderContext;
}): React.JSX.Element {
  const caps = useCaps();
  const activeStyle = useTextStyle("chrome.title");
  const inactiveStyle = useTextStyle("text.muted");
  const dividerStyle = useTextStyle("chrome.divider");
  const activeChild = node.children[node.active] ?? node.children[0];
  if (!activeChild) return <PaneFrame title="" />;

  // Tab strip: the active tab reads as chrome.title, the rest dim; a thin `·`
  // separates them so the dock header is scannable instead of a run-on of names.
  const sep = caps.unicode ? " · " : " | ";
  const titleNode = (
    <Text>
      {node.children.map((child, i) => (
        <Text key={child.id}>
          {i > 0 ? <Text {...dividerStyle}>{sep}</Text> : null}
          <Text {...(i === node.active ? activeStyle : inactiveStyle)}>
            {tabLabel(child, ctx.view)}
          </Text>
        </Text>
      ))}
    </Text>
  );

  // A leaf active child renders its body directly inside the dock frame (one
  // border, not two); a nested split/stack recurses through the renderer.
  const focused = activeChild.kind === "leaf" && ctx.focusedId === activeChild.id;
  const collapsed =
    activeChild.kind === "leaf" &&
    ctx.collapsedIds.has(activeChild.id) &&
    !isEssentialPanel(activeChild.panel, caps);

  const railSummary =
    activeChild.kind === "leaf" ? panelRailSummary(activeChild.panel, ctx.view) : undefined;

  return (
    <PaneFrame
      title={activeChild.kind === "leaf" ? panelTitle(activeChild.panel, ctx.view) : "dock"}
      titleNode={titleNode}
      focused={focused}
      collapsed={collapsed}
      {...(railSummary ? { railSummary } : {})}
    >
      {activeChild.kind === "leaf" ? (
        <PanelBody panel={activeChild.panel} v={ctx.view} mode={ctx.mode} />
      ) : (
        <PaneRenderer node={activeChild} ctx={ctx} />
      )}
    </PaneFrame>
  );
}
