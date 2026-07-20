/**
 * `<PaneFrame>` (design spec §2.1, §3.1) — the universal bordered container every
 * panel lives in. Owns the title bar, the focus ring (border color + line-weight
 * `─`→`━` via single→double border, plus a `▸` caret so focus survives no-color,
 * §2.7), the collapse rail, and the `alert` variant. Reads tokens only.
 */

import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { useColor, useTextStyle } from "../theme/ThemeProvider.js";

export interface PaneFrameProps {
  title: string;
  /**
   * Rich title content (e.g. a tabbed dock's tab-strip). Rendered in the title
   * bar in place of the plain `title` string, still after the focus caret. The
   * plain `title` remains required for the rail summary + a11y fallback.
   */
  titleNode?: ReactNode;
  subtitle?: string;
  focused?: boolean;
  collapsible?: boolean;
  collapsed?: boolean;
  /** 1-line summary shown when collapsed (§2.6 rail). */
  railSummary?: string;
  variant?: "default" | "ghost" | "alert";
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
  children,
}: PaneFrameProps): React.JSX.Element {
  const caps = useCaps();
  const borderDefault = useColor("chrome.border");
  const borderFocus = useColor("chrome.borderFocus");
  const borderAlert = useColor("error.border");
  const titleStyle = useTextStyle("chrome.title");
  const mutedStyle = useTextStyle("text.muted");
  const focusStyle = useTextStyle("chrome.borderFocus");

  const focusCaret = focused ? `${glyph(caps, "focus")} ` : "";

  if (collapsed) {
    // 1-line rail: `▸ Title · summary` — never a half-drawn panel (§2.6).
    return (
      <Box>
        <Text {...mutedStyle}>
          {glyph(caps, "chevronRight")} {title}
          {railSummary ? ` · ${railSummary}` : ""}
        </Text>
      </Box>
    );
  }

  const borderColor =
    variant === "alert" ? borderAlert : focused ? borderFocus : borderDefault;
  // Line-weight change encodes focus without color (§2.7): single→double box.
  const borderStyle = caps.unicode ? (focused ? "double" : "round") : "single";

  const frameProps: Record<string, unknown> = {
    flexDirection: "column",
    flexGrow: 1,
    borderStyle,
  };
  if (borderColor !== undefined) frameProps.borderColor = borderColor;

  return (
    <Box {...frameProps}>
      <Box>
        <Text {...(focused ? focusStyle : titleStyle)}>{focusCaret}</Text>
        {titleNode ?? <Text {...(focused ? focusStyle : titleStyle)}>{title}</Text>}
        {subtitle ? <Text {...mutedStyle}> · {subtitle}</Text> : null}
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {children}
      </Box>
    </Box>
  );
}
