/**
 * `<CompareView>` — the COMPARE / RACE grid (design spec §2.9.3, Mode B). Lanes
 * are equal-`flexGrow` columns keyed by `UiEvent.lane` (the fan-out key): one
 * column per entry in `view.laneOrder`, driven entirely by the event stream, so
 * a shared prompt fanned to N providers materializes N columns for free. Every
 * hue-coded element carries a **redundant number + letter + provider label** so
 * CVD / no-color users get attribution everywhere (§2.9.3). The focused lane gets
 * a `▸N` caret + double border (`<PaneFrame focused>`); scroll acts on it alone.
 *
 * Below `narrow` (100 cols) the lanes **stack vertically** rather than squeezing
 * into unreadable slivers (§2.9.3 "On narrow, lanes stack vertically").
 *
 * Pure renderer: a selector over `ViewState`, no lane owns state.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { PaneFrame } from "../layout/PaneFrame.js";
import type { LaneState, ViewState } from "../store/viewState.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle } from "../theme/ThemeProvider.js";

export interface CompareViewProps {
  view: ViewState;
  /** Index (into `laneOrder`) of the focused lane; scroll/promote act on it. */
  focusedLane?: number;
  /** Rows available (after chrome). Reserved for the future line-window engine. */
  rows?: number;
  /** Terminal width — drives the horizontal-columns → vertical-stack breakpoint. */
  cols?: number;
}

function laneText(lane: LaneState): { body: string; streaming: boolean } {
  const finalized = lane.finalized.map((t) => t.text || t.reasoning).filter(Boolean).join("\n");
  const live = lane.live ? lane.live.text || lane.live.reasoning : "";
  return { body: [finalized, live].filter(Boolean).join("\n"), streaming: lane.live !== null };
}

function LaneColumn({
  lane,
  index,
  focused,
  stacked,
}: {
  lane: LaneState;
  index: number;
  focused: boolean;
  /** Vertical stack (narrow) vs. side-by-side column (wide). */
  stacked: boolean;
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

  // Title bar carries the full attribution INLINE (number + hue dot + letter +
  // provider name + status), so the body no longer repeats a header line — the
  // duplicated `1 ●A anthropic` row is gone (§2.9.3 "redundant, not repeated").
  const titleNode = (
    <Text>
      <Text {...chromeTitle}>{index + 1} </Text>
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
    <Box
      flexGrow={1}
      flexBasis={0}
      minWidth={stacked ? undefined : 22}
      {...(stacked ? { flexShrink: 0 } : {})}
    >
      <PaneFrame title={`${index + 1} ${provider}`} titleNode={titleNode} focused={focused}>
        <Box flexDirection="column">
          {content ? (
            <Text {...bodyStyle}>
              {content}
              {streaming ? <Text {...cursor}>{glyph(caps, "streaming")}</Text> : null}
            </Text>
          ) : (
            <Text {...muted}>{glyph(caps, "dotHollow")} waiting for {provider}…</Text>
          )}
        </Box>
      </PaneFrame>
    </Box>
  );
}

export function CompareView({ view, focusedLane = 0, cols = 120 }: CompareViewProps): React.JSX.Element {
  const muted = useTextStyle("text.muted");
  const lanes = view.laneOrder;

  if (lanes.length === 0) {
    return (
      <Box flexGrow={1} paddingX={1} paddingY={1}>
        <Text {...muted}>
          · no lanes yet — submit a prompt to fan it out across providers
        </Text>
      </Box>
    );
  }

  // Side-by-side while each lane clears a legible width; below `narrow` stack
  // them vertically so nothing shrinks into an unreadable sliver (§2.9.3).
  const stacked = cols < 100 || cols / lanes.length < 30;

  return (
    <Box flexDirection={stacked ? "column" : "row"} flexGrow={1} gap={stacked ? 0 : 1}>
      {lanes.map((laneKey, i) => {
        const lane = view.lanes[laneKey];
        if (!lane) return null;
        return <LaneColumn key={laneKey} lane={lane} index={i} focused={i === focusedLane} stacked={stacked} />;
      })}
    </Box>
  );
}
