/**
 * `<CommandBar>` (design spec §2.4) — the bottom chrome: a mode indicator, the
 * `<InputBox>` composer, a failover chip, and a live hint row that always
 * surfaces the active submit binding (§6.2 — "no user is ever stranded unable to
 * send"). Persistent chrome: a fixed set of rows, never a tree node.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { selectFailover } from "../store/selectors.js";
import type { ViewState } from "../store/viewState.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { InputBox } from "./InputBox.js";
import type { InterruptMode } from "../interrupt/interrupt.js";
import type { UiMode } from "./mode.js";

export interface CommandBarProps {
  mode: UiMode;
  view: ViewState;
  onSubmit?: (text: string) => void;
  onInterrupt?: (mode: InterruptMode) => void;
  history?: readonly string[];
  isActive?: boolean;
  /** Injected clock for deterministic input tests. */
  now?: () => number;
  /** Bubbles the composer's empty/non-empty state to the keymap owner (§6.1). */
  onComposingChange?: (composing: boolean) => void;
  /** Reserve `1`–`4` for the outer compare-lane scope while the draft is empty. */
  reserveDigitsWhenEmpty?: boolean;
}

export function CommandBar({
  mode,
  view,
  onSubmit,
  onInterrupt,
  history,
  isActive = true,
  now,
  onComposingChange,
  reserveDigitsWhenEmpty = false,
}: CommandBarProps): React.JSX.Element {
  const caps = useCaps();
  const badge = useTextStyle("accent.emphasis");
  const hint = useTextStyle("text.muted");
  const boltStyle = useTextStyle("warning.fg");
  const failover = selectFailover(view);
  const sep = caps.unicode ? " · " : " - ";

  const hints = [
    "Enter send",
    `${caps.unicode ? "⌥" : "Alt+"}Enter newline`,
    `${caps.unicode ? "⇧⭾" : "Shift+Tab"} mode`,
    "/ cmd",
    `${caps.unicode ? "⌃P" : "Ctrl+P"} palette`,
  ].join(sep);

  return (
    <Box flexDirection="column">
      {failover ? (
        <Box>
          <Text {...boltStyle}>
            {glyph(caps, "bolt")} failover active
          </Text>
        </Box>
      ) : null}
      <Box>
        <Text {...badge}>[{mode}] </Text>
        <Box flexGrow={1}>
          <InputBox
            {...(onSubmit ? { onSubmit } : {})}
            {...(onInterrupt ? { onInterrupt } : {})}
            {...(history ? { history } : {})}
            isActive={isActive}
            {...(now ? { now } : {})}
            {...(onComposingChange ? { onComposingChange } : {})}
            reserveDigitsWhenEmpty={reserveDigitsWhenEmpty}
          />
        </Box>
      </Box>
      <Box>
        <Text {...hint}>{hints}</Text>
      </Box>
    </Box>
  );
}
