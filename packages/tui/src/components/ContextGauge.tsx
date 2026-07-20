/**
 * `<ContextGauge>` (design spec §2.5, §3.7) — the context-window meter:
 * `ctx 84.2k/200k ▓▓▓░░ ⧗`. `max` is the **real** window (engine-owned; the TUI
 * never invents it); when it differs from a marketing `nominal` the gauge shows
 * `200k real / 1M nominal` (kills the "1M" lie). The bar tints `cost.warn` past
 * the autocompact threshold and `cost.crit` near the limit; an `⧗ autocompact`
 * tick appears at the threshold. Pure `gaugeTier` helper is headless-testable.
 */

import { Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { buildBar, formatTokens } from "../chrome/StatusHud.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { Icon, resolveIcon } from "./Icon.js";

export type GaugeTier = "ok" | "warn" | "crit";

/** Bar tier: `crit` ≥0.9, `warn` at/after the autocompact threshold, else `ok`. */
export function gaugeTier(pct: number, autocompactAt: number): GaugeTier {
  if (pct >= 0.9) return "crit";
  if (autocompactAt > 0 && pct >= autocompactAt) return "warn";
  return "ok";
}

export interface ContextGaugeProps {
  used: number;
  /** Real context window (engine-owned). */
  max: number;
  /** Marketing/nominal window; shown as `real / nominal` when it differs. */
  nominal?: number;
  /** Bar width in cells. Default 14. */
  width?: number;
  /** Autocompact threshold (0..1) that lights the `⧗` tick + `warn` tint. */
  autocompactAt?: number;
  measure?: (s: string) => number;
}

export function ContextGauge({
  used,
  max,
  nominal,
  width = 14,
  autocompactAt = 0.85,
  measure,
}: ContextGaugeProps): React.JSX.Element {
  const caps = useCaps();
  const muted = useTextStyle("text.muted");
  const accent = useTextStyle("accent.default");
  const warn = useTextStyle("cost.warn");
  const crit = useTextStyle("cost.crit");

  const pct = max > 0 ? Math.min(1, used / max) : 0;
  const tier = gaugeTier(pct, autocompactAt);
  const barStyle = tier === "crit" ? crit : tier === "warn" ? warn : accent;

  const full = resolveIcon("barFull", caps, measure);
  const empty = resolveIcon("barEmpty", caps, measure);
  const showNominal = nominal !== undefined && nominal !== max;

  return (
    <Text>
      <Text {...muted}>ctx </Text>
      <Text {...accent}>
        {formatTokens(used)}/{formatTokens(max)}
        {showNominal ? ` real / ${formatTokens(nominal)} nominal` : ""}{" "}
      </Text>
      <Text {...barStyle}>{buildBar(pct, width, full, empty)}</Text>
      {autocompactAt > 0 && pct >= autocompactAt ? (
        <Text {...warn}>
          {" "}
          <Icon name="autocompact" style={warn} {...(measure ? { measure } : {})} /> autocompact
        </Text>
      ) : null}
    </Text>
  );
}
