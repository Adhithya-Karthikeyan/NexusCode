/**
 * Mode A — scrollback render (design spec §2.0). Finalized turns are committed to
 * Ink's `<Static>`, becoming native terminal scrollback (real copy/paste,
 * wheel-scroll, resize-survival). Only the **live region** (the in-flight tail +
 * the framed live panels) re-renders below. This is the default for `chat`/`agent`.
 *
 * The committed turns render through the same `<UserPrompt>` + `<MessageView>`
 * pair the conversation-first surface uses. They used to be printed as a bare
 * `<Text>{turn.text}</Text>`, which meant every pane preset showed the assistant's
 * Markdown **as source** — literal `## What changed`, literal ``` fences, literal
 * backticks — unwrapped, unindented, and in a visual language completely unlike
 * the bordered panes directly beneath it. One transcript renderer, one look.
 */

import { Box, Static } from "ink";
import { PaneRenderer, type PaneRenderContext } from "../layout/PaneRenderer.js";
import { selectAllFinalizedTurns } from "../store/selectors.js";
import type { ViewState } from "../store/viewState.js";
import type { PaneNode } from "../layout/tree.js";
import { MessageView } from "./MessageView.js";
import { UserPrompt } from "./UserPrompt.js";

export interface ScrollbackViewProps {
  view: ViewState;
  tree: PaneNode;
  ctx: PaneRenderContext;
  /** Terminal width; the transcript wraps to it. */
  width?: number;
}

export function ScrollbackView({ view, tree, ctx, width = 80 }: ScrollbackViewProps): React.JSX.Element {
  const finalized = selectAllFinalizedTurns(view);
  const provider = view.session?.provider ?? "custom";
  return (
    <Box flexDirection="column" width={width}>
      <Static items={finalized}>
        {(turn) => (
          <Box key={turn.id} flexDirection="column" width={width}>
            {turn.prompt !== undefined ? <UserPrompt text={turn.prompt} width={width} /> : null}
            <MessageView turn={turn} provider={provider} width={width} />
          </Box>
        )}
      </Static>
      <Box flexDirection="column" width={width}>
        <PaneRenderer node={tree} ctx={ctx} />
      </Box>
    </Box>
  );
}
