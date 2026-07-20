/**
 * `<MessageView>` — one assistant turn rendered Claude-Code style: a provider-hued
 * marker, an optional thinking line, the answer as streaming **Markdown** (headings,
 * lists, and syntax-highlighted code blocks via `<Markdown>`/`<CodeBlock>`), then
 * the turn's tool calls as compact inline `<ToolLine>`s and file edits as collapsed
 * `<DiffSummary>`s. A typing indicator trails the text while the turn is live. Pure
 * renderer over one {@link ../store/viewState.Turn}.
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

export function MessageView({ turn, provider, streaming = false, width = 80 }: MessageViewProps): React.JSX.Element {
  const caps = useCaps();
  const providerStyle = useTextStyle(providerToken(provider));
  const thinkStyle = useTextStyle("stream.thinking");
  // Content sits under a 2-cell gutter (marker `●A`); wrap to the remaining width
  // so long lines and code blocks never overflow past the right edge.
  const gutter = 2;
  const bodyWidth = Math.max(20, width - gutter);

  const hasText = turn.text.length > 0;
  const waiting = streaming && !hasText && turn.reasoning.length === 0;

  return (
    <Box flexDirection="column" marginBottom={1} width={width}>
      {/* Provider marker — hue + redundant letter (never color-only). */}
      <Box>
        <Text {...providerStyle}>
          {glyph(caps, "dotFilled")}
          {providerLetter(provider)}
        </Text>
        {waiting ? (
          <Text> <TypingIndicator active label="thinking" /></Text>
        ) : null}
      </Box>

      {/* Reasoning (thinking) — dim, above the answer. */}
      {turn.reasoning ? (
        <Box marginLeft={gutter} width={bodyWidth}>
          <Text {...thinkStyle} italic>
            {caps.unicode ? "⋯ " : "... "}
            {turn.reasoning}
          </Text>
        </Box>
      ) : null}

      {/* The answer, as streaming Markdown. */}
      {hasText ? (
        <Box marginLeft={gutter} width={bodyWidth} flexDirection="column">
          <Markdown content={turn.text} width={bodyWidth} />
          {streaming ? (
            <Box>
              <StreamingCursor active />
            </Box>
          ) : null}
        </Box>
      ) : null}

      {/* Inline, compact tool activity. */}
      {turn.tools.map((tool) => (
        <ToolLine key={tool.id} tool={tool} width={width} />
      ))}

      {/* Collapsed file-edit summaries. */}
      {turn.diffs.map((diff, i) => (
        <DiffSummary key={`${diff.path}-${i}`} diff={diff} width={width} />
      ))}
    </Box>
  );
}
