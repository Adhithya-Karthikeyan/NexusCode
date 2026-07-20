/**
 * `<Splitter>` (design spec §2.1, §2.6) — the 1-cell divider Ink injects between
 * split children. Brightens (chrome.borderFocus) when resize is armed; otherwise
 * a calm `chrome.divider`. Vertical splits get a `│` column, horizontal a `─` row.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import type { Axis } from "./tree.js";

export interface SplitterProps {
  axis: Axis;
  /** Resize-armed (Ctrl+W) — brightens the divider (§2.6). */
  armed?: boolean;
}

export function Splitter({ axis, armed = false }: SplitterProps): React.JSX.Element {
  const caps = useCaps();
  const divider = useTextStyle("chrome.divider");
  const focus = useTextStyle("chrome.borderFocus");
  const style = armed ? focus : divider;

  // A `row` split stacks children horizontally → the divider is a vertical bar.
  if (axis === "row") {
    const bar = caps.unicode ? "│" : "|";
    return (
      <Box flexDirection="column" flexShrink={0}>
        <Text {...style}>{bar}</Text>
      </Box>
    );
  }
  const bar = caps.unicode ? "─" : "-";
  return (
    <Box flexShrink={0}>
      <Text {...style}>{bar}</Text>
    </Box>
  );
}
