/**
 * Terminal capability detection + the non-TTY mount guard (design spec §3.0,
 * §2.8, §10.4-6). Resolved once at boot: color depth, unicode, size, no-color,
 * screen-reader, reduced-motion. Pure functions over an env + stream snapshot so
 * they are fully headless-testable.
 */

import type { ResolveCaps } from "@nexuscode/theme";

/** The full capability set every component reads via `useCaps()` (§3.0). */
export interface Capabilities {
  truecolor: boolean;
  colors256: boolean;
  unicode: boolean;
  noColor: boolean;
  screenReader: boolean;
  reducedMotion: boolean;
  mouse: boolean;
  isTTY: boolean;
  termDumb: boolean;
  width: number;
  height: number;
}

/** Minimal stream shape we probe (a subset of `WriteStream`). */
export interface StreamLike {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

type Env = Record<string, string | undefined>;

/** Below this width the framed TUI refuses and falls back to linear mode (§2.8). */
export const MIN_TUI_COLS = 40;

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/** Detect color depth from env (`COLORTERM`, `TERM`, `NO_COLOR`, `--plain`). */
function detectColor(env: Env): { truecolor: boolean; colors256: boolean; noColor: boolean } {
  const noColor = truthy(env.NO_COLOR) || truthy(env.NEXUS_PLAIN) || env.NEXUS_COLOR === "off";
  const colorterm = (env.COLORTERM ?? "").toLowerCase();
  const term = (env.TERM ?? "").toLowerCase();
  const truecolor = !noColor && (colorterm === "truecolor" || colorterm === "24bit");
  const colors256 =
    !noColor && (truecolor || term.includes("256color") || term.includes("256"));
  return { truecolor, colors256, noColor };
}

/**
 * Resolve capabilities from an environment + output stream. Defaults assume a
 * modern terminal but degrade safely: unknown `TERM` → 16-color, `TERM=dumb` →
 * everything off.
 */
export function detectCapabilities(
  env: Env = process.env,
  stdout: StreamLike = process.stdout as unknown as StreamLike,
): Capabilities {
  const termDumb = (env.TERM ?? "").toLowerCase() === "dumb";
  const isTTY = stdout.isTTY === true;
  const { truecolor, colors256, noColor } = detectColor(env);
  const screenReader = truthy(env.NEXUS_SCREEN_READER) || truthy(env.ACCESSIBLE);
  const reducedMotion =
    truthy(env.NEXUS_REDUCED_MOTION) || (env.NEXUS_MOTION ?? "").toLowerCase() === "none";
  // Unicode is assumed on UTF-8 locales unless ASCII mode is forced.
  const ascii = truthy(env.NEXUS_ASCII) || termDumb;
  const locale = `${env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? ""}`.toLowerCase();
  const unicode = !ascii && (locale.includes("utf-8") || locale.includes("utf8") || locale === "");

  return {
    truecolor,
    colors256,
    unicode,
    noColor: noColor || screenReader,
    screenReader,
    reducedMotion,
    mouse: truthy(env.NEXUS_MOUSE),
    isTTY,
    termDumb,
    width: stdout.columns ?? 80,
    height: stdout.rows ?? 24,
  };
}

/** The color-relevant slice the theme resolver gates on (§3.0). */
export function toResolveCaps(caps: Capabilities): ResolveCaps {
  const out: ResolveCaps = {};
  if (caps.truecolor) out.truecolor = true;
  if (caps.colors256) out.colors256 = true;
  if (caps.noColor) out.noColor = true;
  return out;
}

/** Result of the mountability check (§2.8 degradation ladder step 3). */
export interface MountDecision {
  ok: boolean;
  /** Machine reason when refused. */
  reason?: "non-tty" | "term-dumb" | "too-narrow";
  /** One-line message to print in place of the TUI. */
  fallback?: string;
}

/**
 * Decide whether the framed Ink TUI may mount. Refuses on non-TTY, `TERM=dumb`,
 * or width `< MIN_TUI_COLS`, returning a graceful one-line fallback — the TUI
 * **never crashes** on an incapable terminal (hard rule 4). `NEXUS_FORCE_TUI=1`
 * overrides the width/tty refusal for power users / test rigs.
 */
export function canMountTui(caps: Capabilities, env: Env = process.env): MountDecision {
  const forced = truthy(env.NEXUS_FORCE_TUI);
  if (caps.termDumb && !forced) {
    return {
      ok: false,
      reason: "term-dumb",
      fallback: "TERM=dumb — linear mode. set NEXUS_FORCE_TUI=1 to force the TUI.",
    };
  }
  if (!caps.isTTY && !forced) {
    return {
      ok: false,
      reason: "non-tty",
      fallback: "not a TTY (piped/redirected) — linear mode. set NEXUS_FORCE_TUI=1 to force the TUI.",
    };
  }
  if (caps.width < MIN_TUI_COLS && !forced) {
    return {
      ok: false,
      reason: "too-narrow",
      fallback: `terminal too narrow (need ≥${MIN_TUI_COLS}) — linear mode. widen or set NEXUS_FORCE_TUI=1`,
    };
  }
  return { ok: true };
}
