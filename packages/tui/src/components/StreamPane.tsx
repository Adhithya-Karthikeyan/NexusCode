/**
 * `<StreamPane>` — the scrolling conversation surface (design spec §3.2). A pure
 * selector over `ViewState`: it renders one lane's finalized turns + the live
 * (streaming) turn as `<MessageBubble>`s, with the four mandatory data states
 * (§1.3.4): **empty** (dim placeholder), **loading** (thinking indicator),
 * **error** (inline error bubble + retry hint), and the normal stream.
 *
 * Render modes (§2.0): in `scrollback` (Mode A) finalized turns may flush to
 * Ink `<Static>` — real terminal scrollback — while only the live tail
 * re-renders; in `viewport` (Mode B) everything renders inline for the manual
 * viewport engine. `autoscroll` pauses on scroll-up and shows a `▼ N new` cue.
 */

import { Box, Static, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { MAIN_LANE } from "../store/events.js";
import { selectFinalizedTurns, selectLiveTurn, selectModel } from "../store/selectors.js";
import type { Turn, ViewState } from "../store/viewState.js";
import type { RenderMode } from "../layout/tree.js";
import { MessageBubble } from "./MessageBubble.js";
import { Markdown } from "./Markdown.js";
import { TypingIndicator } from "./TypingIndicator.js";

export interface StreamPaneProps {
  /** The derived view — the single source the pane selects over. */
  view: ViewState;
  /** Which lane to render (`"main"` for single runs; compare lanes otherwise). */
  lane?: string;
  /** Render mode (§2.0). `scrollback` may flush finalized turns to `<Static>`. */
  mode?: RenderMode;
  /** Wrap width for Markdown/code bodies. */
  width?: number | undefined;
  /** Render turn bodies through `<Markdown>` (default true). */
  markdown?: boolean;
  /** Flush finalized turns to Ink `<Static>` (Mode A scrollback optimization). */
  flushFinalized?: boolean;
  /** Loading skeleton (before the first token) — shows a thinking indicator. */
  loading?: boolean;
  /** Inline error state; renders an error bubble with a retry hint. */
  error?: { message: string; retryable?: boolean };
  /** Count of new messages arrived while scrolled up (autoscroll paused). */
  newCount?: number;
}

/** Body of one turn — Markdown or raw text. */
function TurnBody({ turn, markdown, width }: { turn: Turn; markdown: boolean; width?: number | undefined }): React.JSX.Element {
  if (markdown) return <Markdown content={turn.text} width={width} />;
  const style = useTextStyle("stream.text");
  return <Text {...style}>{turn.text}</Text>;
}

/** One finalized/live turn → reasoning (thinking) + answer bubble. */
function TurnView({
  turn,
  provider,
  streaming,
  markdown,
  width,
}: {
  turn: Turn;
  provider: string;
  streaming: boolean;
  markdown: boolean;
  width?: number | undefined;
}): React.JSX.Element {
  const hasText = turn.text.length > 0;
  return (
    <Box flexDirection="column" marginBottom={1}>
      {turn.reasoning ? (
        <MessageBubble role="assistant" provider={provider} name="reasoning" tone="thinking">
          {turn.reasoning}
        </MessageBubble>
      ) : null}
      {hasText || !turn.reasoning ? (
        <MessageBubble role="assistant" provider={provider} streaming={streaming}>
          <TurnBody turn={turn} markdown={markdown} width={width} />
        </MessageBubble>
      ) : null}
    </Box>
  );
}

/** The conversation stream for one lane. */
export function StreamPane({
  view,
  lane = MAIN_LANE,
  mode = "scrollback",
  width,
  markdown = true,
  flushFinalized = false,
  loading = false,
  error,
  newCount = 0,
}: StreamPaneProps): React.JSX.Element {
  const caps = useCaps();
  const muted = useTextStyle("text.muted");
  const accent = useTextStyle("accent.default");
  const finalized = selectFinalizedTurns(view, lane);
  const live = selectLiveTurn(view, lane);
  const { provider } = selectModel(view);

  const useStatic = flushFinalized && mode === "scrollback";
  const empty = finalized.length === 0 && !live && !loading && !error;

  return (
    <Box flexDirection="column">
      {/* Empty state — never a blank void (§1.3.4). */}
      {empty ? <Text {...muted}>· Ready. Ask anything.</Text> : null}

      {/* Finalized history: to <Static> (Mode A) or inline (Mode B). */}
      {finalized.length > 0 &&
        (useStatic ? (
          <Static items={finalized as Turn[]}>
            {(turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                provider={provider}
                streaming={false}
                markdown={markdown}
                width={width}
              />
            )}
          </Static>
        ) : (
          <Box flexDirection="column">
            {finalized.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                provider={provider}
                streaming={false}
                markdown={markdown}
                width={width}
              />
            ))}
          </Box>
        ))}

      {/* Loading skeleton before the first token. */}
      {loading && !live ? <TypingIndicator label="thinking" active /> : null}

      {/* Live streaming turn (never in <Static>). */}
      {live ? (
        <TurnView turn={live} provider={provider} streaming markdown={markdown} width={width} />
      ) : null}

      {/* Inline error state + retry affordance (§3.2). */}
      {error ? (
        <MessageBubble role="system" tone="error">
          {`${error.message}${error.retryable ? "  [r] retry · [d] details" : "  [d] details"}`}
        </MessageBubble>
      ) : null}

      {/* Autoscroll cue when paused with new messages below (§3.2). */}
      {newCount > 0 ? (
        <Text {...accent}>
          {caps.unicode ? "▼" : "v"} {newCount} new · [End] jump
        </Text>
      ) : null}
    </Box>
  );
}
