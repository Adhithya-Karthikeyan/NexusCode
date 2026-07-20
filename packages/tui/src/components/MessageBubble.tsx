/**
 * `<MessageBubble>` — one conversation turn (design spec §3.2). Role-styled and
 * provider-hued: a left gutter labels the speaker (`▸ you` in accent, `● claude`
 * in the provider hue) and the role is **always in the text** so meaning never
 * depends on color (§1.3.2). `tone='thinking'` renders the body in the
 * AA-verified `stream.thinking` token with a `⋯` prefix; `streaming` appends the
 * live `<StreamingCursor>`.
 *
 * Pure renderer: props in, intent out — it never touches the engine. String
 * children are styled with the tone token; composed children (e.g. `<Markdown>`)
 * are rendered as-is so they carry their own styling.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { useTextStyle, type InkTextStyle } from "../theme/ThemeProvider.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { StreamingCursor } from "./StreamingCursor.js";
import type { ReactNode } from "react";

export type MessageRole = "user" | "assistant" | "system";
export type MessageTone = "default" | "error" | "warn" | "thinking";

export interface MessageBubbleProps {
  /** Speaker role — always surfaced as a text label. */
  role: MessageRole;
  /** Engine provider id (assistant turns) → hue + letter attribution. */
  provider?: string;
  /** Optional speaker name override (e.g. "claude", "gpt"); defaults per role. */
  name?: string;
  /** Body treatment; `thinking` dims + prefixes `⋯` (§3.2). */
  tone?: MessageTone;
  /** Appends the blinking `stream.cursor` while the turn is live. */
  streaming?: boolean;
  /** Optional epoch-ms timestamp (rendered muted, right of the label). */
  timestamp?: number;
  /** Optional token count for the turn (rendered muted). */
  tokens?: number;
  /** Turn body — a string, `<Markdown>`, tool cards, etc. */
  children?: ReactNode;
}

/** The default speaker label for a role when no `name` is given. */
function roleLabel(role: MessageRole, provider?: string): string {
  if (role === "user") return "you";
  if (role === "system") return "system";
  return provider ? provider.toLowerCase() : "assistant";
}

/** Format an epoch-ms timestamp as `HH:MM` (24h), stable & locale-free. */
function clock(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/** One role-styled, provider-hued conversation turn. */
export function MessageBubble({
  role,
  provider,
  name,
  tone = "default",
  streaming = false,
  timestamp,
  tokens,
  children,
}: MessageBubbleProps): React.JSX.Element {
  const caps = useCaps();
  const accent = useTextStyle("accent.default");
  const muted = useTextStyle("text.muted");
  const providerStyle = useTextStyle(role === "assistant" && provider ? providerToken(provider) : "text.primary");

  // Gutter marker: `▸` for the user, `●` (+ letter) for a provider-attributed turn.
  const isUser = role === "user";
  const marker = isUser ? glyph(caps, "focus") : glyph(caps, "dotFilled");
  const label = name ?? roleLabel(role, provider);
  const letter = role === "assistant" && provider ? providerLetter(provider) : null;
  const gutterStyle: InkTextStyle = isUser ? accent : providerStyle;

  // Body tone token (§3.2): thinking → dim AA-safe; error/warn → state color.
  const bodyToken =
    tone === "thinking"
      ? "stream.thinking"
      : tone === "error"
        ? "error.fg"
        : tone === "warn"
          ? "warning.fg"
          : "stream.text";
  const bodyStyle = useTextStyle(bodyToken);
  const thinkingPrefix = tone === "thinking" ? (caps.unicode ? "⋯ " : "... ") : "";

  const meta: string[] = [];
  if (timestamp !== undefined) meta.push(clock(timestamp));
  if (tokens !== undefined) meta.push(`${tokens} tok`);

  return (
    <Box flexDirection="column">
      <Box>
        <Text {...gutterStyle}>
          {marker} {label}
          {letter ? ` (${letter})` : ""}
        </Text>
        {meta.length > 0 ? <Text {...muted}>{"  " + meta.join(" · ")}</Text> : null}
      </Box>
      <Box flexDirection="column" paddingLeft={2}>
        {typeof children === "string" ? (
          <Text {...bodyStyle}>
            {thinkingPrefix}
            {children}
            {streaming ? <StreamingCursor active /> : null}
          </Text>
        ) : (
          <Box flexDirection="column">
            {children}
            {streaming ? (
              <Text>
                <StreamingCursor active />
              </Text>
            ) : null}
          </Box>
        )}
      </Box>
    </Box>
  );
}
