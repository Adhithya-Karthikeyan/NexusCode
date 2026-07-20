/**
 * `<Picker>` (task B) — the ONE reusable interactive pick-list every option-bearing
 * slash command opens. A bordered overlay above the input: a scrollable, windowed
 * list with arrow-key navigation, filter-as-you-type, `Enter` to select, `Esc` to
 * cancel, and the currently-active value highlighted (`●`). Rows may carry a group
 * header (e.g. the provider a model belongs to), a dim right-hand hint, and a small
 * color swatch (theme accent preview). Pure + headless-testable: it owns only its
 * transient query/selection; the chosen `value` is handed back via `onSelect`.
 */

import { Box, Text, useInput, useStdin } from "ink";
import { useMemo, useState } from "react";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { useColor, useTextStyle } from "../theme/ThemeProvider.js";
import type { PickerItem } from "./commands.js";

export interface PickerProps {
  items: readonly PickerItem[];
  /** Fired with the chosen row's opaque value (and the row). */
  onSelect: (value: string, item: PickerItem) => void;
  /** Fired on Esc / cancel. */
  onCancel: () => void;
  title?: string;
  /** Capture keys (default true). Gated on raw-mode support (headless-safe). */
  isActive?: boolean;
  /** Max rows shown at once (windowed around the selection). Default 8. */
  maxVisible?: number;
  /** Seed filter (also the controlled value used by render tests). */
  initialQuery?: string;
  /** Seed selection index (render tests). */
  initialIndex?: number;
  /** Overall width of the overlay. */
  width?: number;
  /** Subtle one-line hint shown below the key-help row (e.g. a related command). */
  footer?: string;
}

/** Case-insensitive substring filter over label + hint + group. */
export function filterItems(items: readonly PickerItem[], query: string): PickerItem[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...items];
  return items.filter((it) =>
    `${it.label} ${it.hint ?? ""} ${it.group ?? ""}`.toLowerCase().includes(q),
  );
}

export function Picker({
  items,
  onSelect,
  onCancel,
  title = "Select",
  isActive = true,
  maxVisible = 8,
  initialQuery = "",
  initialIndex = 0,
  width = 64,
  footer,
}: PickerProps): React.JSX.Element {
  const caps = useCaps();
  const { isRawModeSupported } = useStdin();
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(initialIndex);

  const results = useMemo(() => filterItems(items, query), [items, query]);
  const sel = results.length === 0 ? 0 : Math.min(selected, results.length - 1);

  const accent = useTextStyle("accent.default");
  const titleStyle = useTextStyle("chrome.title");
  const text = useTextStyle("text.primary");
  const muted = useTextStyle("text.muted");
  const focusRing = useTextStyle("focus.ring");
  const borderColor = useColor("chrome.borderFocus");

  const choose = (): void => {
    const item = results[sel];
    if (!item) {
      onCancel();
      return;
    }
    onSelect(item.value, item);
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        choose();
        return;
      }
      if (key.upArrow || (key.tab && key.shift === true)) {
        setSelected((s) => Math.max(0, Math.min(s, results.length - 1) - 1));
        return;
      }
      if (key.downArrow || (key.tab && key.shift !== true)) {
        setSelected((s) => Math.min(results.length - 1, s + 1));
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setSelected(0);
        return;
      }
      if (key.ctrl && input === "u") {
        setQuery("");
        setSelected(0);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input && input >= " ") {
        setQuery((q) => q + input);
        setSelected(0);
      }
    },
    // `=== true`: Ink treats an `undefined` `isActive` (real non-TTY) as active and
    // would throw enabling raw mode; the strict compare keeps it inert.
    { isActive: isActive && isRawModeSupported === true },
  );

  // Window the visible rows around the selection.
  const start = Math.max(
    0,
    Math.min(sel - Math.floor(maxVisible / 2), Math.max(0, results.length - maxVisible)),
  );
  const visible = results.slice(start, start + maxVisible);

  const hintSep = caps.unicode ? " · " : " - ";
  const hints = [
    `${caps.unicode ? "↑↓" : "up/dn"} move`,
    "Enter select",
    "Esc cancel",
    "type to filter",
  ].join(hintSep);

  let lastGroup: string | undefined;

  return (
    <Box
      flexDirection="column"
      borderStyle={caps.unicode ? "round" : "classic"}
      {...(borderColor ? { borderColor } : {})}
      paddingX={1}
      width={width}
    >
      <Box>
        <Text {...accent}>{glyph(caps, "node")}</Text>
        <Text {...titleStyle}> {title}</Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text {...muted}>
            {results.length} option{results.length === 1 ? "" : "s"}
          </Text>
        </Box>
      </Box>
      <Box>
        <Text {...muted}>{glyph(caps, "chevronRight")} </Text>
        <Text {...accent}>{query}</Text>
        <Text {...text}>{caps.unicode ? "▍" : "|"}</Text>
      </Box>
      {visible.length === 0 ? (
        <Text {...muted}>{caps.unicode ? "·" : "-"} no matches</Text>
      ) : (
        visible.map((item, i) => {
          const index = start + i;
          const isSel = index === sel;
          const showGroup = item.group !== undefined && item.group !== lastGroup;
          lastGroup = item.group;
          return (
            <Box key={`${item.value}-${index}`} flexDirection="column">
              {showGroup ? (
                <Text {...muted}>
                  {"  "}
                  {item.group}
                </Text>
              ) : null}
              <Box>
                <Text {...(isSel ? focusRing : muted)}>
                  {isSel ? glyph(caps, "focus") : " "}{" "}
                </Text>
                {item.swatch !== undefined ? (
                  <Text color={item.swatch}>{glyph(caps, "dotFilled")} </Text>
                ) : null}
                <Text {...(isSel ? text : muted)} bold={isSel}>
                  {item.label}
                </Text>
                {item.current ? <Text {...accent}> {glyph(caps, "dotFilled")}</Text> : null}
                <Box flexGrow={1} justifyContent="flex-end">
                  {item.hint !== undefined ? <Text {...muted}>{item.hint}</Text> : null}
                </Box>
              </Box>
            </Box>
          );
        })
      )}
      <Text {...muted}>{hints}</Text>
      {footer !== undefined ? <Text {...muted}>{footer}</Text> : null}
    </Box>
  );
}
