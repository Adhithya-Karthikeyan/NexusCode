/**
 * `<PaneFrame>` (design spec §2.1, §3.1) — the universal container every panel
 * lives in. Owns the title bar, the focus indication, the collapse rail, and the
 * `alert` variant. Reads tokens only.
 *
 * Three rules this frame now holds that it did not before:
 *
 *  1. **It is exactly as wide as it is told.** `width`/`height` come from
 *     `layout/measure.ts`, not from Yoga guessing at content. Without that a
 *     long title could widen the body past the border and produce the ragged
 *     `││` seams the audit found at 100 and 140 columns.
 *  2. **Text never touches the border.** One column of padding on each side.
 *  3. **Focus is quiet.** It used to swap the border to a heavy double line
 *     (`╔══╗`), which made the chrome the loudest thing on screen while the
 *     answer sat in plain text — exactly backwards. Focus is now carried by the
 *     `▸` caret plus an accented title and border *colour*, at the same line
 *     weight. The caret keeps it legible with no colour at all (§2.7).
 */

import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { useColor, useTextStyle } from "../theme/ThemeProvider.js";
import { PANE_CHROME_X, truncate } from "./measure.js";

export interface PaneFrameProps {
  title: string;
  /**
   * Rich title content (e.g. a tabbed dock's tab-strip). Rendered in the title
   * bar in place of the plain `title` string, still after the focus caret. Must
   * be a single `<Text wrap="truncate-end">` tree so it cannot widen the frame.
   */
  titleNode?: ReactNode;
  subtitle?: string;
  focused?: boolean;
  collapsible?: boolean;
  collapsed?: boolean;
  /** 1-line summary shown when collapsed (§2.6 rail). */
  railSummary?: string;
  variant?: "default" | "ghost" | "alert";
  /** Exact outer width in cells (border included). From `layoutTree`. */
  width?: number;
  /** Exact outer height in cells (border included). From `layoutTree`. */
  height?: number;
  children?: ReactNode;
}

export function PaneFrame({
  title,
  titleNode,
  subtitle,
  focused = false,
  collapsed = false,
  railSummary,
  variant = "default",
  width,
  height,
  children,
}: PaneFrameProps): React.JSX.Element {
  const caps = useCaps();
  const borderDefault = useColor("chrome.border");
  const borderFocus = useColor("chrome.borderFocus");
  const borderAlert = useColor("error.border");
  const titleStyle = useTextStyle("chrome.title");
  const mutedStyle = useTextStyle("text.muted");
  const focusStyle = useTextStyle("chrome.borderFocus");

  if (collapsed) {
    // 1-line rail: `▸ Title · summary` — never a half-drawn panel (§2.6).
    const rail = `${glyph(caps, "chevronRight")} ${title}${railSummary ? ` · ${railSummary}` : ""}`;
    return (
      <Box {...(width ? { width } : {})}>
        <Text {...mutedStyle} wrap="truncate-end">
          {width ? truncate(rail, width, caps.unicode) : rail}
        </Text>
      </Box>
    );
  }

  const borderColor =
    variant === "alert" ? borderAlert : focused ? borderFocus : borderDefault;
  // One line weight in both states: focus is the caret + colour, not a heavier
  // box. `round` reads noticeably lighter than `single` on a real terminal.
  const borderStyle = caps.unicode ? "round" : "single";

  // The usable text column, after the border (2) and our padding (2).
  const inner = width !== undefined ? Math.max(1, width - PANE_CHROME_X) : undefined;
  const titleText = inner !== undefined ? truncate(title, inner - (focused ? 2 : 0), caps.unicode) : title;

  const frameProps: Record<string, unknown> = {
    flexDirection: "column",
    borderStyle,
    paddingX: 1,
    ...(width !== undefined ? { width } : { flexGrow: 1 }),
    // `minHeight`, deliberately not `height`. Ink does not clip a Box whose
    // content is taller than a fixed `height` — it overlays the surplus rows on
    // top of each other, which turned a wrapped code line into
    // `oString("base64url");ytes(32).t`. `overflow: hidden` produces the same
    // corruption (and its X axis additionally disables soft wrapping). A
    // minimum still makes short panes fill their allotment so siblings share a
    // bottom edge, while an over-tall pane grows — legibly — instead of
    // shredding its own text.
    ...(height !== undefined ? { minHeight: height } : {}),
  };
  if (borderColor !== undefined) frameProps.borderColor = borderColor;

  return (
    <Box {...frameProps}>
      <Box {...(inner !== undefined ? { width: inner } : {})} flexShrink={0}>
        {focused ? (
          <Text {...focusStyle} wrap="truncate-end">
            {glyph(caps, "focus")}{" "}
          </Text>
        ) : null}
        {titleNode ?? (
          <Text {...(focused ? focusStyle : titleStyle)} wrap="truncate-end">
            {titleText}
          </Text>
        )}
        {subtitle ? (
          <Text {...mutedStyle} wrap="truncate-end">
            {" "}
            · {subtitle}
          </Text>
        ) : null}
      </Box>
      {/* `overflowY` only: clipping the *vertical* overflow keeps a tall panel
          inside its frame, but Ink's `overflowX: hidden` also suppresses soft
          wrapping, which rendered a wrapped code block's rows on top of each
          other (`oString("base64url");ytes(32).t`). Horizontal fit is already
          guaranteed by the measured width, so X never needs clipping. */}
      <Box
        flexDirection="column"
        flexGrow={1}
        
        {...(inner !== undefined ? { width: inner } : {})}
      >
        {children}
      </Box>
    </Box>
  );
}
