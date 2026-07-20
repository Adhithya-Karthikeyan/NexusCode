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
  /** Terminal width; the hint row truncates to it rather than wrapping. */
  width?: number;
}

export function CommandBar({
  mode: _mode,
  view,
  onSubmit,
  onInterrupt,
  history,
  isActive = true,
  now,
  onComposingChange,
  reserveDigitsWhenEmpty = false,
  width,
}: CommandBarProps): React.JSX.Element {
  const caps = useCaps();
  const hint = useTextStyle("text.muted");
  const boltStyle = useTextStyle("warning.fg");
  const failover = selectFailover(view);
  const sep = caps.unicode ? " · " : " - ";

  // The hint row is always present (a row that appears and disappears makes the
  // whole screen jump), but it now reports the bindings that apply to the state
  // you are actually in. It used to list the same five chords forever, including
  // "Enter send" while a turn was streaming and the useful key was Esc.
  const key = (uni: string, ascii: string): string => (caps.unicode ? uni : ascii);
  const hints = view.streaming
    ? ["esc interrupt", `esc esc stop`, `${key("⇧⭾", "Shift+Tab")} mode`]
    : [
        `${key("⏎", "Enter")} send`,
        `${key("⌥⏎", "Alt+Enter")} newline`,
        "/ cmd",
        `${key("⌃P", "Ctrl+P")} palette`,
        `${key("⇧⭾", "Shift+Tab")} mode`,
      ];

  // The mode badge lives in the identity strip; repeating it in front of the
  // caret gave the composer row a `[CHAT] ◆ ▸ type a message…` triple prefix.
  return (
    <Box flexDirection="column" {...(width ? { width } : {})}>
      {failover ? (
        <Box>
          <Text {...boltStyle}>{glyph(caps, "bolt")} failover active</Text>
        </Box>
      ) : null}
      <Box>
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
      <Box {...(width ? { width } : {})}>
        <Text {...hint} wrap="truncate-end">
          {hints.join(sep)}
        </Text>
      </Box>
    </Box>
  );
}
