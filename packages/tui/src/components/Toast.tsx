/**
 * `<Toast>` (design spec §3.8, §7) — a single transient notice. Level-coded
 * (`info/success/warning/error`) via the `state.*` tokens, always carrying a
 * status glyph **and** the level word so meaning survives no-color (§1.3.2).
 * Purely presentational (a pure renderer holds no engine state); an optional
 * self-dismiss timer (`ttlMs` + `onExpire`) is a view-lifecycle convenience the
 * host may opt into. Under reduced-motion / screen-reader the slide/fade is a
 * static frame — this component never animates on its own.
 */

import { Box, Text } from "ink";
import { useEffect } from "react";
import type { TokenId } from "@nexuscode/theme";
import { useCaps } from "../caps/CapabilityProvider.js";
import { useColor, useTextStyle } from "../theme/ThemeProvider.js";
import { Icon, type IconName } from "./Icon.js";

export type ToastLevel = "info" | "success" | "warning" | "error";

const LEVEL_FG: Record<ToastLevel, TokenId> = {
  info: "info.fg",
  success: "success.fg",
  warning: "warning.fg",
  error: "error.fg",
};

const LEVEL_BORDER: Record<ToastLevel, TokenId> = {
  info: "info.border",
  success: "success.border",
  warning: "warning.border",
  error: "error.border",
};

const LEVEL_ICON: Record<ToastLevel, IconName> = {
  info: "info",
  success: "ok",
  warning: "warn",
  error: "error",
};

export interface ToastProps {
  message: string;
  /** Severity → color + glyph + word. Default `info`. */
  level?: ToastLevel;
  /** Optional bold title line above the message. */
  title?: string;
  /** Draw a bordered card (default) vs a bare inline line. */
  bordered?: boolean;
  /** Self-dismiss after N ms → fires `onExpire`. Omit to persist. */
  ttlMs?: number;
  onExpire?: () => void;
  measure?: (s: string) => number;
}

export function Toast({
  message,
  level = "info",
  title,
  bordered = true,
  ttlMs,
  onExpire,
  measure,
}: ToastProps): React.JSX.Element {
  const caps = useCaps();
  const fg = useTextStyle(LEVEL_FG[level]);
  const muted = useTextStyle("text.muted");
  const borderColor = useColor(LEVEL_BORDER[level]);

  useEffect(() => {
    if (ttlMs === undefined || onExpire === undefined) return;
    const timer = setTimeout(onExpire, ttlMs);
    return () => clearTimeout(timer);
  }, [ttlMs, onExpire]);

  const body = (
    <Box flexDirection="column">
      {title !== undefined ? (
        <Box>
          <Icon name={LEVEL_ICON[level]} style={fg} {...(measure ? { measure } : {})} />
          <Text {...fg}> {title}</Text>
          <Text {...muted}> · {level}</Text>
        </Box>
      ) : (
        <Box>
          <Icon name={LEVEL_ICON[level]} style={fg} {...(measure ? { measure } : {})} />
          <Text {...fg}> {message}</Text>
        </Box>
      )}
      {title !== undefined ? <Text {...muted}>{message}</Text> : null}
    </Box>
  );

  if (!bordered) return body;
  return (
    <Box
      borderStyle={caps.unicode ? "round" : "classic"}
      {...(borderColor ? { borderColor } : {})}
      paddingX={1}
    >
      {body}
    </Box>
  );
}
