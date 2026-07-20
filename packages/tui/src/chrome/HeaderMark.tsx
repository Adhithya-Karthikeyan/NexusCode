/**
 * `<HeaderMark>` (design spec §1.2, §2.3) — the brand identity line. In Mode A it
 * rides as a 1-line compact strip above the HUD (`◆ session · [MODE] · ●A model ·
 * ⟳ · $cost`); in Mode B it is the pinned top header the viewport owns. The
 * wordmark is `Nexus` (text.primary) + `Code` (accent), the node `◆` is the brand
 * atom. Provider hue carries a redundant letter (`●A`) so no-color still attributes.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import type { UiMode } from "./mode.js";

export interface HeaderMarkProps {
  /** Session name/title (e.g. "refactor-auth-session"). */
  session?: string;
  mode: UiMode;
  /**
   * Badge label override. `mode` names the interaction mode; a layout like
   * COMPARE is not a ring mode (§6.3) yet must still read `[COMPARE]` in the
   * header, so the caller can override the badge text without faking the mode.
   */
  badgeLabel?: string;
  /** Extra identity segment after the badge (e.g. `3 lanes` for compare). */
  detail?: string;
  model?: string;
  provider?: string;
  streaming?: boolean;
  costUsd?: number;
  /** Show the full `◆ NexusCode` wordmark (Mode B header) vs. the compact strip. */
  showWordmark?: boolean;
  /**
   * Terminal width. The strip truncates to it instead of wrapping — at 60 cols
   * the dashboard header used to fold into two ragged rows with the segments
   * landing under each other at random columns and `[CHAT]` losing its bracket.
   */
  width?: number;
}

export function HeaderMark({
  session,
  mode,
  badgeLabel,
  detail,
  model,
  provider,
  streaming = false,
  costUsd,
  showWordmark = false,
  width,
}: HeaderMarkProps): React.JSX.Element {
  const caps = useCaps();
  const node = useTextStyle("accent.default");
  const wordPrimaryStyle = useTextStyle("text.primary");
  const wordAccentStyle = useTextStyle("accent.default");
  const badgeStyle = useTextStyle("accent.emphasis");
  const mutedStyle = useTextStyle("text.muted");
  const costStyle = useTextStyle("cost.ok");
  const streamStyle = useTextStyle("stream.cursor");
  const providerStyle = useTextStyle(providerToken(provider ?? "custom"));

  const sep = ` ${caps.unicode ? "·" : "-"} `;

  // Fixed segments sit in `flexShrink={0}` boxes so Ink (which hard-codes
  // `flexShrink: 1` on every `<Text>`) cannot shave the brand or the mode badge;
  // only the free-text segments — the session name and the model id — give up
  // space, and they truncate rather than wrap the row.
  return (
    <Box {...(width ? { width } : {})}>
      <Box flexShrink={0}>
        <Text {...node} wrap="truncate-end">
          {glyph(caps, "node")}{" "}
        </Text>
        {showWordmark ? (
          <Text wrap="truncate-end">
            <Text {...wordPrimaryStyle}>Nexus</Text>
            <Text {...wordAccentStyle}>Code</Text>
            <Text {...mutedStyle}>{sep}</Text>
          </Text>
        ) : null}
      </Box>
      {session ? (
        <Box flexShrink={1} minWidth={0}>
          <Text {...wordPrimaryStyle} wrap="truncate-end">
            {session}
          </Text>
        </Box>
      ) : null}
      <Box flexShrink={0}>
        {session ? (
          <Text {...mutedStyle} wrap="truncate-end">
            {sep}
          </Text>
        ) : null}
        <Text {...badgeStyle} wrap="truncate-end">
          [{badgeLabel ?? mode}]
        </Text>
        {detail ? (
          <Text wrap="truncate-end">
            <Text {...mutedStyle}>{sep}</Text>
            <Text {...mutedStyle}>{detail}</Text>
          </Text>
        ) : null}
        {model ? (
          <Text wrap="truncate-end">
            <Text {...mutedStyle}>{sep}</Text>
            <Text {...providerStyle}>
              {glyph(caps, "dotFilled")}
              {providerLetter(provider ?? "?")}
            </Text>
          </Text>
        ) : null}
      </Box>
      {model ? (
        <Box flexShrink={1} minWidth={0}>
          <Text {...wordPrimaryStyle} wrap="truncate-end">
            {" "}
            {model}
          </Text>
        </Box>
      ) : null}
      <Box flexShrink={0}>
        {streaming ? (
          <Text wrap="truncate-end">
            <Text {...mutedStyle}>{sep}</Text>
            <Text {...streamStyle}>{glyph(caps, "streaming")}</Text>
          </Text>
        ) : null}
        {costUsd !== undefined ? (
          <Text wrap="truncate-end">
            <Text {...mutedStyle}>{sep}</Text>
            <Text {...costStyle}>${costUsd.toFixed(2)}</Text>
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
