/**
 * `<UserPrompt>` — the user's turn, shown Claude-Code style with a subtle accent
 * prefix (`› …`). Pure presentational: the conversation shell tracks submitted
 * prompts as client view state (the engine `UiEvent` stream carries only the
 * assistant side) and echoes them here, interleaved with assistant turns.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { GUTTER } from "./MessageView.js";

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
  // `› ` leads the first line — the idiom every prompt echo in this UI uses, and
  // tight enough that the chevron reads as attached to the text. Continuation
  // lines instead hang at `GUTTER`, the same column the assistant's body uses,
  // so a wrapped multi-line prompt stays a clean block rather than stepping in
  // and out. (Padding the chevron out to the full gutter on line one would align
  // the two markers perfectly but leaves a distracting `›  ` gap on what is
  // usually a single short line.)
  const lines = text.split("\n");
  const bodyWidth = width ? Math.max(10, width - GUTTER) : undefined;
  return (
    <Box flexDirection="column" marginBottom={1} {...(width ? { width } : {})}>
      {lines.map((line, i) => (
        <Box key={i}>
          <Text {...markStyle}>{i === 0 ? `${chevron} ` : " ".repeat(GUTTER)}</Text>
          <Box {...(bodyWidth ? { width: bodyWidth } : {})}>
            <Text {...textStyle}>{line}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
