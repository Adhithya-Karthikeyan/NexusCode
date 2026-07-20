/**
 * `<SlashMenu>` — the on-demand slash-command autocomplete. When the draft starts
 * with `/`, a small filtered list appears above the input so subsystems are
 * reachable without being on-screen (`/model`, `/theme`, `/context`, `/cost`,
 * `/trace`, `/clear`, `/help`, `/tools`). Pure presentational: it reads the draft
 * text and paints matches; execution is the shell's concern.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { useTextStyle } from "../theme/ThemeProvider.js";

export interface SlashCommand {
  name: string;
  desc: string;
}

/** The built-in slash commands surfaced by the conversation shell. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/model", desc: "switch the active model" },
  { name: "/theme", desc: "change the color theme" },
  { name: "/provider", desc: "switch the active provider" },
  { name: "/agent", desc: "set the interaction role" },
  { name: "/tools", desc: "list available tools" },
  { name: "/mcp", desc: "list MCP servers" },
  { name: "/context", desc: "show context window usage" },
  { name: "/cost", desc: "show session + run cost" },
  { name: "/trace", desc: "open the run trace" },
  { name: "/help", desc: "list all commands" },
  { name: "/clear", desc: "clear the conversation" },
  { name: "/new", desc: "start a new session" },
  { name: "/quit", desc: "exit NexusCode" },
];

/** Whether a draft should trigger the slash menu, and the matching commands. */
export function slashMatches(draft: string): SlashCommand[] {
  if (!draft.startsWith("/")) return [];
  // Only the first token is the command; once a space is typed it's an argument.
  if (draft.includes(" ")) return [];
  const q = draft.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

export interface SlashMenuProps {
  draft: string;
  /** Cap the rows shown (default 6). */
  limit?: number;
}

export function SlashMenu({ draft, limit = 6 }: SlashMenuProps): React.JSX.Element | null {
  const caps = useCaps();
  const nameStyle = useTextStyle("accent.default");
  const descStyle = useTextStyle("text.muted");
  const matches = slashMatches(draft);
  if (matches.length === 0) return null;

  const visible = matches.slice(0, limit);
  return (
    <Box flexDirection="column" marginBottom={0}>
      {visible.map((c) => (
        <Box key={c.name}>
          <Text {...descStyle}>{glyph(caps, "chevronRight")} </Text>
          <Text {...nameStyle}>{c.name}</Text>
          <Text {...descStyle}>  {c.desc}</Text>
        </Box>
      ))}
    </Box>
  );
}
