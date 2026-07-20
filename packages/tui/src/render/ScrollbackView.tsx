/**
 * Mode A — scrollback render (design spec §2.0). Finalized turns are committed to
 * Ink's `<Static>`, becoming native terminal scrollback (real copy/paste,
 * wheel-scroll, resize-survival). Only the **live region** (the in-flight tail +
 * the framed live panels) re-renders below. This is the default for `chat`/`agent`.
 */

import { Box, Static, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { PaneRenderer, type PaneRenderContext } from "../layout/PaneRenderer.js";
import { selectAllFinalizedTurns } from "../store/selectors.js";
import type { Turn, ViewState } from "../store/viewState.js";
import type { PaneNode } from "../layout/tree.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle } from "../theme/ThemeProvider.js";

function FinalizedTurn({ turn, provider }: { turn: Turn; provider: string }): React.JSX.Element {
  const caps = useCaps();
  const gutter = useTextStyle(providerToken(provider));
  const body = useTextStyle("stream.text");
  return (
    <Box flexDirection="column">
      <Text>
        <Text {...gutter}>
          {glyph(caps, "dotFilled")}
          {providerLetter(provider)}{" "}
        </Text>
        <Text {...body}>{turn.text || turn.reasoning}</Text>
      </Text>
    </Box>
  );
}

export interface ScrollbackViewProps {
  view: ViewState;
  tree: PaneNode;
  ctx: PaneRenderContext;
}

export function ScrollbackView({ view, tree, ctx }: ScrollbackViewProps): React.JSX.Element {
  const finalized = selectAllFinalizedTurns(view);
  const provider = view.session?.provider ?? "custom";
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Static items={finalized}>
        {(turn) => <FinalizedTurn key={turn.id} turn={turn} provider={provider} />}
      </Static>
      <Box flexGrow={1}>
        <PaneRenderer node={tree} ctx={ctx} />
      </Box>
    </Box>
  );
}
