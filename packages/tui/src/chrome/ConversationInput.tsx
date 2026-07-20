/**
 * `<ConversationInput>` — the pinned bottom composer for the conversation view.
 * Wraps the working `<InputBox>` (type → Enter sends; Esc / Esc-Esc interrupts;
 * multiline; paste-guarded — the keystroke handling is reused verbatim, never
 * regressed) and layers the discoverability chrome on top:
 *
 *  - a slash-command **menu** that appears the moment the draft is a bare `/token`,
 *    filters as you type, and is driven by the SAME keys the composer owns
 *    (`↑/↓` move, `Enter` run, `Tab` complete, `Esc` close) via `onNavigate`;
 *  - the generic `<Picker>` overlay, opened when the chosen command carries options
 *    (`/model`, `/theme`, `/provider`, …) — one consistent pick-list UX for all.
 *
 * Pure chrome: it observes the draft the composer owns and never holds it; command
 * actions come from the injected registry and only touch TUI-local/session state.
 */

import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { useCaps } from "../caps/CapabilityProvider.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import type { InterruptMode } from "../interrupt/interrupt.js";
import { InputBox } from "./InputBox.js";
import { SlashMenu } from "./SlashMenu.js";
import { CommandMenu } from "./CommandMenu.js";
import { Picker } from "./Picker.js";
import { matchCommands, type PickerItem, type SlashCommandSpec } from "./commands.js";

export interface ConversationInputProps {
  onSubmit?: (text: string) => void;
  onInterrupt?: (mode: InterruptMode) => void;
  history?: readonly string[];
  isActive?: boolean;
  now?: () => number;
  /** The slash-command registry (real data). Absent → the legacy static menu. */
  commands?: readonly SlashCommandSpec[];
  /** Composer width (drives the overlay widths). */
  width?: number;
}

interface ActivePicker {
  items: readonly PickerItem[];
  title: string;
  onSelect: (value: string) => void;
  footer?: string;
}

export function ConversationInput({
  onSubmit,
  onInterrupt,
  history,
  isActive = true,
  now,
  commands,
  width = 80,
}: ConversationInputProps): React.JSX.Element {
  const caps = useCaps();
  const hintStyle = useTextStyle("text.muted");
  const [draft, setDraft] = useState("");
  const [menuSel, setMenuSel] = useState(0);
  const [picker, setPicker] = useState<ActivePicker | null>(null);
  const [reset, setReset] = useState({ seq: 0, text: "" });

  const overlayWidth = Math.min(Math.max(40, width - 2), 72);
  const matches = commands ? matchCommands(commands, draft) : [];
  const menuOpen = picker === null && matches.length > 0;

  // Clamp the selection when the match set shrinks (filtering as the user types).
  useEffect(() => {
    if (menuSel > Math.max(0, matches.length - 1)) setMenuSel(0);
  }, [matches.length, menuSel]);

  const clearInput = (): void => setReset((r) => ({ seq: r.seq + 1, text: "" }));
  const setInput = (text: string): void => setReset((r) => ({ seq: r.seq + 1, text }));

  const openCommand = (cmd: SlashCommandSpec): void => {
    setMenuSel(0);
    clearInput();
    if (cmd.optionsProvider) {
      void Promise.resolve(cmd.optionsProvider()).then((items) => {
        setPicker({
          items,
          title: cmd.pickerTitle ?? cmd.name,
          ...(cmd.pickerFooter !== undefined ? { footer: cmd.pickerFooter } : {}),
          onSelect: (value) => {
            cmd.action?.(value);
            setPicker(null);
          },
        });
      });
    } else {
      cmd.action?.();
    }
  };

  const onNavigate = (action: "up" | "down" | "select" | "complete" | "cancel"): boolean => {
    if (!menuOpen) return false;
    const n = matches.length;
    switch (action) {
      case "up":
        setMenuSel((s) => (s - 1 + n) % n);
        return true;
      case "down":
        setMenuSel((s) => (s + 1) % n);
        return true;
      case "select": {
        const cmd = matches[Math.min(menuSel, n - 1)] ?? matches[0];
        if (cmd) openCommand(cmd);
        return true;
      }
      case "complete": {
        const cmd = matches[Math.min(menuSel, n - 1)] ?? matches[0];
        if (cmd) setInput(`${cmd.name} `);
        return true;
      }
      case "cancel":
        clearInput();
        setMenuSel(0);
        return true;
    }
  };

  const prompt = caps.unicode ? "▸" : ">";
  const sep = caps.unicode ? " · " : " - ";
  // Stable composer hint (the open menu shows its own ↑↓/Enter/Tab/Esc guide).
  const hint = [`${caps.unicode ? "⏎" : "Enter"} send`, "esc stop", "/ commands"].join(sep);

  return (
    <Box flexDirection="column" width={width}>
      {picker ? (
        <Picker
          items={picker.items}
          title={picker.title}
          isActive={isActive}
          width={overlayWidth}
          {...(picker.footer !== undefined ? { footer: picker.footer } : {})}
          onSelect={(value) => picker.onSelect(value)}
          onCancel={() => setPicker(null)}
        />
      ) : menuOpen ? (
        <CommandMenu matches={matches} selected={menuSel} width={overlayWidth} />
      ) : commands ? null : (
        <SlashMenu draft={draft} />
      )}
      <Box>
        <InputBox
          promptLabel={prompt}
          onDraftChange={setDraft}
          onNavigate={onNavigate}
          resetTo={reset}
          {...(onSubmit ? { onSubmit } : {})}
          {...(onInterrupt ? { onInterrupt } : {})}
          {...(history ? { history } : {})}
          isActive={isActive && picker === null}
          {...(now ? { now } : {})}
        />
      </Box>
      {picker === null ? (
        <Box>
          <Text {...hintStyle}>{hint}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
