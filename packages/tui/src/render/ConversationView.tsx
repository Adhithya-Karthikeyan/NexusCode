/**
 * `<ConversationView>` — the conversation-first surface (Claude-Code style). A
 * SINGLE scrolling transcript: finalized turns commit to Ink `<Static>` (real
 * terminal scrollback — copy/paste, wheel-scroll, resize-survival) while only the
 * in-flight turn re-renders in a live region below. User prompts are interleaved
 * from client-tracked `prompts` (the engine `UiEvent` stream carries only the
 * assistant side); assistant turns, tools and diffs are pure selectors over
 * `ViewState`. A clean onboarding/empty state shows before the first turn.
 */

import { Box, Static, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { MAIN_LANE } from "../store/events.js";
import { selectFinalizedTurns, selectLiveTurn, selectModel } from "../store/selectors.js";
import type { Turn, ViewState } from "../store/viewState.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { MessageView } from "./MessageView.js";
import { UserPrompt } from "./UserPrompt.js";

/** One committed exchange: the user prompt (if any) + the assistant turn. */
interface Block {
  key: string;
  prompt?: string;
  turn: Turn;
}

export interface ConversationViewProps {
  view: ViewState;
  /** Client-tracked user prompts, in submit order (echoed above each turn). */
  prompts?: readonly string[];
  width?: number;
  /** Fallback notice shown in the empty state (e.g. "running on mock provider"). */
  fallbackNotice?: string;
}

/** Clean onboarding / empty state — never a blank void. */
function EmptyState({ view, fallbackNotice }: { view: ViewState; fallbackNotice?: string }): React.JSX.Element {
  const caps = useCaps();
  const node = useTextStyle("accent.default");
  const primary = useTextStyle("text.primary");
  const muted = useTextStyle("text.muted");
  const { model, provider } = selectModel(view);
  const providerStyle = useTextStyle(providerToken(provider === "—" ? "custom" : provider));

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text {...node}>{glyph(caps, "node")} </Text>
        <Text {...primary}>NexusCode</Text>
        <Text {...muted}> — ask anything. </Text>
        <Text {...muted}>/help for commands.</Text>
      </Box>
      {provider !== "—" ? (
        <Box>
          <Text {...providerStyle}>
            {glyph(caps, "dotFilled")}
            {providerLetter(provider)}{" "}
          </Text>
          <Text {...muted}>
            {provider} · {model}
          </Text>
        </Box>
      ) : null}
      {fallbackNotice ? (
        <Box>
          <Text {...muted}>
            {glyph(caps, "warn")} {fallbackNotice}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function ConversationView({
  view,
  prompts = [],
  width = 80,
  fallbackNotice,
}: ConversationViewProps): React.JSX.Element {
  const provider = selectModel(view).provider;
  const providerId = provider === "—" ? "custom" : provider;
  const finalized = selectFinalizedTurns(view, MAIN_LANE);
  const live = selectLiveTurn(view, MAIN_LANE);

  // Prompt↔turn pairing is INTRINSIC when the turn carries the prompt that
  // started it (client injected a `prompt` marker into the log). We fall back to
  // the legacy positional echo (`prompts[i]`) only for turns with no stamped
  // prompt — never mixing the two on one turn — so an interrupted turn, an
  // error-before-stream, or a prompt that starts no turn can no longer shift
  // every later answer under the wrong prompt (and, since <Static> commits are
  // permanent, corrupt the session).
  const blocks: Block[] = finalized.map((turn, i) => {
    const b: Block = { key: turn.id, turn };
    const prompt = turn.prompt ?? prompts[i];
    if (prompt !== undefined) b.prompt = prompt;
    return b;
  });

  // The in-flight turn's prompt: intrinsic if stamped, else the trailing
  // positional prompt. When a turn is live there is no separate "pending" prompt.
  const livePrompt = live ? live.prompt ?? prompts[finalized.length] : undefined;
  // A positional prompt submitted with no live turn yet (legacy echo path only).
  const pendingPrompt = live ? undefined : prompts[finalized.length];
  const empty = finalized.length === 0 && !live && prompts.length === 0;

  return (
    <Box flexDirection="column">
      {empty ? <EmptyState view={view} {...(fallbackNotice ? { fallbackNotice } : {})} /> : null}

      {/* Finalized transcript → real terminal scrollback. */}
      <Static items={blocks}>
        {(block) => (
          <Box key={block.key} flexDirection="column">
            {block.prompt !== undefined ? <UserPrompt text={block.prompt} width={width} /> : null}
            <MessageView turn={block.turn} provider={providerId} width={width} />
          </Box>
        )}
      </Static>

      {/* Live region — the in-flight prompt + streaming turn. */}
      {pendingPrompt !== undefined ? <UserPrompt text={pendingPrompt} width={width} /> : null}
      {livePrompt !== undefined ? <UserPrompt text={livePrompt} width={width} /> : null}
      {live ? <MessageView turn={live} provider={providerId} streaming width={width} /> : null}
    </Box>
  );
}
