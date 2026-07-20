/**
 * `<ToolActivity>` — the Tool Activity list (design spec §2.2 `tool_activity`,
 * §3.3 `<ToolActivityItem>`, §6). A **pure renderer**: it takes an array of
 * tool-call/result items and paints one row each, every status carried by a
 * **glyph + color + word** so meaning survives no-color / CVD (§1.3.2 — color is
 * never load-bearing). The store's {@link ../store/viewState.ToolActivity} shape
 * is structurally assignable to {@link ToolActivityEntry}.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph, type GlyphName } from "../caps/glyphs.js";
import type { TokenId } from "@nexuscode/theme";
import { useTextStyle, type InkTextStyle } from "../theme/ThemeProvider.js";

/** Lifecycle of one tool invocation (§3.3). Superset of the store's status. */
export type ToolStatus = "pending" | "running" | "ok" | "warn" | "error" | "denied";

/** One tool-call/result row. `detail` is an optional right-hand summary. */
export interface ToolActivityEntry {
  id: string;
  name: string;
  status: ToolStatus;
  /** e.g. `1.2 kb`, `8ms`, an arg summary, or an error message. */
  detail?: string;
  lane?: string;
}

export interface ToolActivityProps {
  items: readonly ToolActivityEntry[];
  /** Cap the number of rows; shows the most recent `limit`. Default: all. */
  limit?: number;
  /** Prepend a 1-line count summary (`✓5 ⚠1 ✗0 ⟳3`). Default: false. */
  showCounts?: boolean;
  /** Placeholder line when there are no items. */
  emptyLabel?: string;
}

/** Glyph + color token + screen-reader word for each status (never color-only). */
const STATUS: Record<ToolStatus, { glyph: GlyphName; token: TokenId; word: string }> = {
  ok: { glyph: "ok", token: "success.fg", word: "ok" },
  warn: { glyph: "warn", token: "warning.fg", word: "warn" },
  denied: { glyph: "warn", token: "warning.fg", word: "denied" },
  error: { glyph: "error", token: "error.fg", word: "error" },
  running: { glyph: "running", token: "accent.default", word: "running" },
  pending: { glyph: "dotHollow", token: "text.muted", word: "queued" },
};

export function ToolActivity({
  items,
  limit,
  showCounts = false,
  emptyLabel = "no tool calls",
}: ToolActivityProps): React.JSX.Element {
  const caps = useCaps();
  const muted = useTextStyle("text.muted");

  // Resolve every status style once (hooks can't run inside a map).
  const styles: Record<ToolStatus, InkTextStyle> = {
    ok: useTextStyle("success.fg"),
    warn: useTextStyle("warning.fg"),
    denied: useTextStyle("warning.fg"),
    error: useTextStyle("error.fg"),
    running: useTextStyle("accent.default"),
    pending: useTextStyle("text.muted"),
  };

  if (items.length === 0) {
    return <Text {...muted}>· {emptyLabel}</Text>;
  }

  const visible = limit !== undefined ? items.slice(-limit) : items;

  return (
    <Box flexDirection="column">
      {showCounts ? <CountSummary items={items} muted={muted} caps={caps} /> : null}
      {visible.map((t) => {
        const s = STATUS[t.status];
        return (
          <Text key={t.id} {...styles[t.status]}>
            {glyph(caps, s.glyph)} {t.name}
            {t.detail ? (
              <Text {...muted}>
                {" "}
                {t.detail}
              </Text>
            ) : null}
          </Text>
        );
      })}
    </Box>
  );
}

/** Compact `✓5 ⚠1 ✗2 ⟳3` tally line (§2.2 rail summary shape). */
function CountSummary({
  items,
  muted,
  caps,
}: {
  items: readonly ToolActivityEntry[];
  muted: InkTextStyle;
  caps: ReturnType<typeof useCaps>;
}): React.JSX.Element {
  let ok = 0;
  let warn = 0;
  let err = 0;
  let run = 0;
  for (const t of items) {
    if (t.status === "ok") ok++;
    else if (t.status === "warn" || t.status === "denied") warn++;
    else if (t.status === "error") err++;
    else if (t.status === "running") run++;
  }
  return (
    <Text {...muted}>
      {glyph(caps, "ok")}
      {ok} {glyph(caps, "warn")}
      {warn} {glyph(caps, "error")}
      {err} {glyph(caps, "running")}
      {run}
    </Text>
  );
}
