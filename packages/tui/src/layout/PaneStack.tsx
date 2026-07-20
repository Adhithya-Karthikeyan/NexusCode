/**
 * `<PaneStack>` (design spec §2.1, §2.6) — the tabbed dock. A `stack` node holds
 * N children but shows one; the frame's title bar IS the tab strip, cycled with
 * `Ctrl+]`. Only the active child renders.
 *
 * The strip used to render as `Tool Activity · Running Tasks · Logs · 0 err` —
 * a run-on sentence in which you could not tell where one tab ended, which tab
 * was active (colour alone carried it), or that `0 err` was a count rather than
 * a fourth tab. Three fixes:
 *
 *  - the active tab is marked **structurally**, with brackets and bold, so it
 *    survives no-colour and colour-blindness;
 *  - tabs are separated by `│`, which reads as a boundary; `·` reads as prose;
 *  - live counts are no longer baked into tab *names* (see `panelTitle`) — the
 *    active tab's count trails the strip as a dim badge.
 *
 * The whole strip is one `<Text wrap="truncate-end">` so it can never widen the
 * pane, and it degrades to the active tab alone when the dock is too narrow to
 * seat every name.
 */

import { Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { collectLeaves, type StackNode } from "./tree.js";
import { isEssentialPanel, PanelBody, panelRailSummary, panelTitle } from "../panels/panels.js";
import { PANE_CHROME_X, PANE_CHROME_Y } from "./measure.js";
import { PaneFrame } from "./PaneFrame.js";
import { PaneRenderer, sizeProps, type PaneRenderContext } from "./PaneRenderer.js";
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
  const badgeStyle = useTextStyle("text.muted");
  const activeChild = node.children[node.active] ?? node.children[0];
  if (!activeChild) return <PaneFrame title="" />;

  const rect = ctx.layout?.get(node.id);
  const inner = rect ? Math.max(1, rect.width - PANE_CHROME_X) : undefined;

  const labels = node.children.map((c) => tabLabel(c, ctx.view));
  const sep = caps.unicode ? " │ " : " | ";

  // The active tab is bracketed rather than caret-marked: `<PaneFrame>` already
  // spends a `▸` on *focus*, and using the same glyph for *active tab* rendered
  // a baffling `▸ ▸ Files` double caret on any focused dock. Brackets are a
  // distinct, long-established tab idiom and survive no-colour just as well.
  const fullWidth = labels.reduce((a, l) => a + l.length + 2, 0) + sep.length * (labels.length - 1);
  const showAll = inner === undefined || fullWidth <= inner;

  const count = activeChild.kind === "leaf" ? panelRailSummary(activeChild.panel, ctx.view) : "";

  const titleNode = (
    <Text wrap="truncate-end">
      {showAll ? (
        node.children.map((child, i) => (
          <Text key={child.id}>
            {i > 0 ? <Text {...dividerStyle}>{sep}</Text> : null}
            {i === node.active ? (
              <Text {...activeStyle} bold>
                [{labels[i]}]
              </Text>
            ) : (
              <Text {...inactiveStyle}> {labels[i]} </Text>
            )}
          </Text>
        ))
      ) : (
        <Text>
          <Text {...activeStyle} bold>
            [{labels[node.active] ?? labels[0]}]
          </Text>
          {node.children.length > 1 ? (
            <Text {...inactiveStyle}>
              {" "}
              {node.active + 1}/{node.children.length}
            </Text>
          ) : null}
        </Text>
      )}
      {count ? <Text {...badgeStyle}>{`  ${count}`}</Text> : null}
    </Text>
  );

  // A leaf active child renders its body directly inside the dock frame (one
  // border, not two); a nested split/stack recurses through the renderer.
  const focused = activeChild.kind === "leaf" && ctx.focusedId === activeChild.id;
  const collapsed =
    activeChild.kind === "leaf" &&
    ctx.collapsedIds.has(activeChild.id) &&
    !isEssentialPanel(activeChild.panel, caps);

  return (
    <PaneFrame
      title={activeChild.kind === "leaf" ? panelTitle(activeChild.panel, ctx.view) : "dock"}
      titleNode={titleNode}
      focused={focused}
      collapsed={collapsed}
      {...(count ? { railSummary: count } : {})}
      {...sizeProps(ctx, rect)}
    >
      {activeChild.kind === "leaf" ? (
        <PanelBody
          panel={activeChild.panel}
          v={ctx.view}
          mode={ctx.mode}
          {...(inner !== undefined ? { width: inner } : {})}
          {...(rect && ctx.fitHeight ? { maxRows: Math.max(1, rect.height - PANE_CHROME_Y) } : {})}
        />
      ) : (
        <PaneRenderer node={activeChild} ctx={ctx} />
      )}
    </PaneFrame>
  );
}
