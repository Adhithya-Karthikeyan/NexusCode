/**
 * `<CommandMenu>` — the interactive slash-command autocomplete overlay (task A).
 * When the draft is a bare `/token`, this paints the matching commands (name +
 * description) above the input with the active row highlighted. It is purely
 * presentational: the key handling (↑/↓ move, Enter choose, Tab complete, Esc
 * close) lives in `<InputBox>` via `onNavigate`, and the selection index is owned
 * by `<ConversationInput>`. Populated from the real slash-command registry.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import type { SlashCommandSpec } from "./commands.js";

export interface CommandMenuProps {
  matches: readonly SlashCommandSpec[];
  /** Highlighted row index. */
  selected: number;
  /** Cap the rows shown (default 8). */
  limit?: number;
  width?: number;
}

export function CommandMenu({
  matches,
  selected,
  limit = 8,
  width = 64,
}: CommandMenuProps): React.JSX.Element | null {
  const caps = useCaps();
  const nameStyle = useTextStyle("accent.default");
  const descStyle = useTextStyle("text.muted");
  const focusRing = useTextStyle("focus.ring");
  const nameSel = useTextStyle("text.primary");
  if (matches.length === 0) return null;

  const sel = Math.max(0, Math.min(selected, matches.length - 1));
  const start = Math.max(0, Math.min(sel - Math.floor(limit / 2), Math.max(0, matches.length - limit)));
  const visible = matches.slice(start, start + limit);

  const hintSep = caps.unicode ? " · " : " - ";
  const hints = [
    `${caps.unicode ? "↑↓" : "up/dn"} move`,
    "Enter run",
    "Tab complete",
    "Esc close",
  ].join(hintSep);

  return (
    <Box flexDirection="column" width={width}>
      {visible.map((c, i) => {
        const isSel = start + i === sel;
        return (
          <Box key={c.name}>
            <Text {...(isSel ? focusRing : descStyle)}>
              {isSel ? glyph(caps, "focus") : " "}{" "}
            </Text>
            <Text {...(isSel ? nameSel : nameStyle)} bold={isSel}>
              {c.name}
            </Text>
            <Text {...descStyle}>
              {"  "}
              {c.description}
            </Text>
          </Box>
        );
      })}
      <Text {...descStyle}>{hints}</Text>
    </Box>
  );
}
