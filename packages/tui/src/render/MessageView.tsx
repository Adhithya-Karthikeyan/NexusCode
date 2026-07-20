/**
 * `<MessageView>` — one assistant turn rendered Claude-Code style: a provider-hued
 * marker, an optional thinking line, the answer as streaming **Markdown** (headings,
 * lists, and syntax-highlighted code blocks via `<Markdown>`/`<CodeBlock>`), then
 * the turn's tool calls as compact inline `<ToolLine>`s and file edits as collapsed
 * `<DiffSummary>`s. A typing indicator trails the text while the turn is live. Pure
 * renderer over one {@link ../store/viewState.Turn}.
 *
 * Layout: the marker is a **hanging indent**, not a heading. It used to sit alone
 * on its own row with the answer starting underneath, which burned one row per
 * turn — a third of an 80×24 screen across four turns, and it left the marker
 * visually detached from the text it attributes. Now the marker occupies a fixed
 * {@link GUTTER}-cell column and the first line of the answer sits beside it, so
 * every line of the turn — prose, tool lines, diffs — shares one left edge.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { Markdown } from "../components/Markdown.js";
import { TypingIndicator } from "../components/TypingIndicator.js";
import { StreamingCursor } from "../components/StreamingCursor.js";
import { ToolLine } from "./ToolLine.js";
import { DiffSummary } from "./DiffSummary.js";
import type { Turn } from "../store/viewState.js";

export interface MessageViewProps {
  turn: Turn;
  provider: string;
  /** Whether this turn is the in-flight (streaming) one. */
  streaming?: boolean;
  width?: number;
}

/**
 * Width of the marker column (`●A` + one separating space). Every content row of
 * a turn — and the user's prompt, which uses the same measure — hangs off this
 * edge, so the transcript reads as one column rather than a ragged stack.
 */
export const GUTTER = 3;

export function MessageView({ turn, provider, streaming = false, width = 80 }: MessageViewProps): React.JSX.Element {
  const caps = useCaps();
  const providerStyle = useTextStyle(providerToken(provider));
  const thinkStyle = useTextStyle("stream.thinking");
  // Content hangs to the right of the marker column; wrap to what is left so
  // long lines and code blocks never overflow past the right edge.
  const bodyWidth = Math.max(20, width - GUTTER);

  const hasText = turn.text.length > 0;
  const waiting = streaming && !hasText && turn.reasoning.length === 0;

  return (
    <Box flexDirection="row" marginBottom={1} width={width}>
      {/* Provider marker — hue + redundant letter (never colour-only). */}
      <Box width={GUTTER} flexShrink={0}>
        <Text {...providerStyle}>
          {glyph(caps, "dotFilled")}
          {providerLetter(provider)}
        </Text>
      </Box>

      <Box flexDirection="column" width={bodyWidth}>
        {waiting ? (
          <Text>
            <TypingIndicator active label="thinking" />
          </Text>
        ) : null}

        {/* Reasoning (thinking) — dim, above the answer. */}
        {turn.reasoning ? (
          <Box width={bodyWidth}>
            <Text {...thinkStyle} italic>
              {caps.unicode ? "⋯ " : "... "}
              {turn.reasoning}
            </Text>
          </Box>
        ) : null}

        {/* The answer, as streaming Markdown. */}
        {hasText ? (
          <Box width={bodyWidth} flexDirection="column">
            <Markdown content={turn.text} width={bodyWidth} />
            {streaming ? (
              <Box>
                <StreamingCursor active />
              </Box>
            ) : null}
          </Box>
        ) : null}

        {/* Inline, compact tool activity + collapsed file-edit summaries. Both
            sit in the content column, so they line up with the prose above
            instead of carrying their own private indent. */}
        {turn.tools.map((tool) => (
          <ToolLine key={tool.id} tool={tool} width={bodyWidth} />
        ))}
        {turn.diffs.map((diff, i) => (
          <DiffSummary key={`${diff.path}-${i}`} diff={diff} width={bodyWidth} />
        ))}
      </Box>
    </Box>
  );
}
