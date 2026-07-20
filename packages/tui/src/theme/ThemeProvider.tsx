/**
 * `ThemeProvider` + `useToken` (design spec §3.0, §4.1). Binds the active
 * `NexusTheme` to a memoizing resolver gated on the current terminal
 * capabilities, and exposes token lookups to the tree. **Components import token
 * names only** — no raw hex ever appears in a component (§10.4-2). A theme swap
 * is a new resolver + one re-render; geometry is untouched.
 */

import {
  createThemeResolver,
  nexusNoir,
  type NexusTheme,
  type ResolvedColor,
  type TextAttr,
  type TokenId,
} from "@nexuscode/theme";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useCaps } from "../caps/CapabilityProvider.js";
import { toResolveCaps } from "../caps/capabilities.js";

interface ThemeContextValue {
  theme: NexusTheme;
  resolve: (token: TokenId) => ResolvedColor;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  /** Active theme; defaults to Nexus Noir (the flagship dark, §5.1). */
  theme?: NexusTheme;
  children: ReactNode;
}

export function ThemeProvider({ theme = nexusNoir, children }: ThemeProviderProps): React.JSX.Element {
  const caps = useCaps();
  const value = useMemo<ThemeContextValue>(() => {
    const resolve = createThemeResolver(theme, toResolveCaps(caps));
    return { theme, resolve };
  }, [theme, caps]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useToken()/useTheme() must be used within <ThemeProvider>");
  return ctx;
}

/** The active theme (id, meta, mode). */
export function useTheme(): NexusTheme {
  return useThemeContext().theme;
}

/** Resolve one semantic token to its capability-gated color + attributes. */
export function useToken(token: TokenId): ResolvedColor {
  return useThemeContext().resolve(token);
}

/**
 * Ink `<Text>` style props for a foreground token: color + the mandatory
 * redundant attributes (bold/dim/underline/…) so meaning survives no-color
 * (§1.3.2). Spread directly onto a `<Text>`.
 */
export interface InkTextStyle {
  /**
   * A hex color string (Ink/chalk auto-downgrades to the terminal's real depth,
   * so the resolver's quantized fields stay available via `useToken` for advanced
   * callers while Ink gets a value it accepts). Absent in monochrome mode.
   */
  color?: string;
  bold?: boolean;
  dimColor?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  inverse?: boolean;
}

/** Map resolved attributes to Ink `<Text>` boolean props. */
export function attrsToInk(attrs: readonly TextAttr[]): InkTextStyle {
  const style: InkTextStyle = {};
  for (const a of attrs) {
    switch (a) {
      case "bold":
        style.bold = true;
        break;
      case "dim":
        style.dimColor = true;
        break;
      case "italic":
        style.italic = true;
        break;
      case "underline":
        style.underline = true;
        break;
      case "strikethrough":
        style.strikethrough = true;
        break;
      case "reverse":
        style.inverse = true;
        break;
    }
  }
  return style;
}

/** Full Ink `<Text>` style for a foreground token (color + attrs). */
export function useTextStyle(token: TokenId): InkTextStyle {
  const resolved = useToken(token);
  const style = attrsToInk(resolved.attrs);
  if (resolved.hex !== undefined) style.color = resolved.hex;
  return style;
}

/** The hex color string for a token (for `borderColor` / `backgroundColor`). */
export function useColor(token: TokenId): string | undefined {
  return useToken(token).hex;
}
