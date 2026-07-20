/**
 * `<UserPrompt>` — the user's turn, shown Claude-Code style with a subtle accent
 * prefix (`› …`). Pure presentational: the conversation shell tracks submitted
 * prompts as client view state (the engine `UiEvent` stream carries only the
 * assistant side) and echoes them here, interleaved with assistant turns.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { useTextStyle } from "../theme/ThemeProvider.js";

export interface UserPromptProps {
  text: string;
  /** Overall width; the text wraps within `width − 2` (the chevron gutter). */
  width?: number;
}

export function UserPrompt({ text, width }: UserPromptProps): React.JSX.Element {
  const caps = useCaps();
  const markStyle = useTextStyle("accent.default");
  const textStyle = useTextStyle("text.secondary");
  const chevron = caps.unicode ? "›" : ">";
  // First line carries the chevron; continuations align under a 2-cell gutter that
  // matches the assistant marker, so user and assistant turns share one left edge.
  const lines = text.split("\n");
  const bodyWidth = width ? Math.max(10, width - 2) : undefined;
  return (
    <Box flexDirection="column" marginBottom={1} {...(width ? { width } : {})}>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text {...markStyle}>{i === 0 ? `${chevron} ` : "  "}</Text>
          <Box {...(bodyWidth ? { width: bodyWidth } : {})}>
            <Text {...textStyle}>{line}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
