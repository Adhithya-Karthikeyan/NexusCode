/**
 * `<CompareView>` — the COMPARE / RACE grid (design spec §2.9.3, Mode B). Lanes
 * are columns keyed by `UiEvent.lane` (the fan-out key): one column per entry in
 * `view.laneOrder`, driven entirely by the event stream, so a shared prompt
 * fanned to N providers materializes N columns for free. Every hue-coded element
 * carries a **redundant number + letter + provider label** so CVD / no-colour
 * users get attribution everywhere (§2.9.3).
 *
 * Two things changed after the layout audit:
 *
 *  - **Columns are measured, not flexed.** Equal `flexGrow` let a long word push
 *    a lane past its own frame; the audit caught body text running through the
 *    right border and eating the inter-column gap. Widths are now integers that
 *    sum exactly to the terminal, and every lane wraps to its own measure.
 *  - **Every lane states its outcome the same way.** The status glyph and finish
 *    reason sit at a fixed place in each title, so lanes can be compared by
 *    scanning one column rather than reading three differently-shaped headers.
 *    (Per-lane cost is deliberately absent: `ViewState` only tracks usage
 *    globally, and inventing a per-lane number here would be a lie.)
 *
 * Below `narrow` (100 cols) lanes **stack vertically** rather than squeezing into
 * unreadable slivers (§2.9.3).
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { PaneFrame } from "../layout/PaneFrame.js";
import { distribute, PANE_CHROME_X, PANE_GAP } from "../layout/measure.js";
import type { LaneState, ViewState } from "../store/viewState.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle } from "../theme/ThemeProvider.js";

export interface CompareViewProps {
  view: ViewState;
  /** Index (into `laneOrder`) of the focused lane; scroll/promote act on it. */
  focusedLane?: number;
  /** Rows available (after chrome). */
  rows?: number;
  /** Terminal width — drives the horizontal-columns → vertical-stack breakpoint. */
  cols?: number;
}

/** A lane needs this much text column before side-by-side stops being useful. */
const MIN_LANE_WIDTH = 30;

function laneText(lane: LaneState): { body: string; streaming: boolean } {
  const finalized = lane.finalized.map((t) => t.text || t.reasoning).filter(Boolean).join("\n");
  const live = lane.live ? lane.live.text || lane.live.reasoning : "";
  return { body: [finalized, live].filter(Boolean).join("\n"), streaming: lane.live !== null };
}

function LaneColumn({
  lane,
  index,
  focused,
  width,
  height,
}: {
  lane: LaneState;
  index: number;
  focused: boolean;
  width: number;
  height?: number;
}): React.JSX.Element {
  const caps = useCaps();
  const provider = lane.lane;
  const hue = useTextStyle(providerToken(provider));
  const bodyStyle = useTextStyle("stream.text");
  const cursor = useTextStyle("stream.cursor");
  const muted = useTextStyle("text.muted");
  const okStyle = useTextStyle("success.fg");
  const chromeTitle = useTextStyle("chrome.title");
  const { body: content, streaming } = laneText(lane);
  const done = lane.finalized.length > 0 && !streaming;
  const finish = lane.finalized[lane.finalized.length - 1]?.finishReason ?? "done";
  const inner = Math.max(1, width - PANE_CHROME_X);

  // `2 ●O openai  ⟳` / `2 ●O openai  ✓` — number and letter carry attribution
  // without colour; the state glyph sits at a predictable place in every lane.
  const titleNode = (
    <Text wrap="truncate-end">
      <Text {...chromeTitle} bold>
        {index + 1}{" "}
      </Text>
      <Text {...hue}>
        {glyph(caps, "dotFilled")}
        {providerLetter(provider)}
      </Text>
      <Text {...chromeTitle}> {provider} </Text>
      {streaming ? (
        <Text {...cursor}>{glyph(caps, "streaming")}</Text>
      ) : done ? (
        <Text {...okStyle}>
          {glyph(caps, "ok")} {finish}
        </Text>
      ) : (
        <Text {...muted}>{glyph(caps, "dotHollow")}</Text>
      )}
    </Text>
  );

  return (
    <Box width={width} flexShrink={0} flexDirection="column">
      <PaneFrame
        title={`${index + 1} ${provider}`}
        titleNode={titleNode}
        focused={focused}
        width={width}
        {...(height ? { height } : {})}
      >
        <Box flexDirection="column" width={inner}>
          <Box width={inner}>
            {content ? (
              <Text {...bodyStyle}>
                {content}
                {streaming ? <Text {...cursor}> {glyph(caps, "streaming")}</Text> : null}
              </Text>
            ) : (
              <Text {...muted} wrap="truncate-end">
                {glyph(caps, "dotHollow")} waiting…
              </Text>
            )}
          </Box>
        </Box>
      </PaneFrame>
    </Box>
  );
}

export function CompareView({
  view,
  focusedLane = 0,
  rows,
  cols = 120,
}: CompareViewProps): React.JSX.Element {
  const muted = useTextStyle("text.muted");
  const lanes = view.laneOrder;

  if (lanes.length === 0) {
    return (
      <Box flexGrow={1} paddingX={1} paddingY={1}>
        <Text {...muted}>· no lanes yet — submit a prompt to fan it out across providers</Text>
      </Box>
    );
  }

  // Side-by-side while each lane clears a legible measure; below that stack them
  // vertically so nothing shrinks into an unreadable sliver (§2.9.3).
  const gaps = PANE_GAP * (lanes.length - 1);
  const stacked = cols < 100 || (cols - gaps) / lanes.length < MIN_LANE_WIDTH;

  // Exact integer widths that sum to the terminal — never a flex approximation.
  const widths = stacked
    ? lanes.map(() => cols)
    : distribute(
        cols,
        lanes.map(() => ({ basis: 0, grow: 1, min: MIN_LANE_WIDTH })),
        PANE_GAP,
      );

  const stackedHeight =
    stacked && rows ? Math.max(4, Math.floor(rows / Math.max(1, lanes.length))) : undefined;

  return (
    <Box
      flexDirection={stacked ? "column" : "row"}
      width={cols}
      {...(stacked ? {} : { gap: PANE_GAP })}
    >
      {lanes.map((laneKey, i) => {
        const lane = view.lanes[laneKey];
        const width = widths[i] ?? 0;
        if (!lane || width <= 0) return null;
        return (
          <LaneColumn
            key={laneKey}
            lane={lane}
            index={i}
            focused={i === focusedLane}
            width={width}
            {...(stacked
              ? stackedHeight
                ? { height: stackedHeight }
                : {}
              : rows
                ? { height: Math.max(4, rows) }
                : {})}
          />
        );
      })}
    </Box>
  );
}
