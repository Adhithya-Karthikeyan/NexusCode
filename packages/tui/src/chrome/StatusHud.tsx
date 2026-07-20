/**
 * `<StatusHud>` (design spec §2.5, §3.7) — the always-visible, tiered status line.
 * Tier 0 (compact, default ≤119 cols): context bar + session cost + active
 * provider dot + failover light. Tier 1 (full, ≥120 cols): adds run cost + all
 * provider health dots. Everything is a selector over `ViewState`; provider dots
 * are passive (derived from real outcomes) and always carry a word + letter, never
 * color-only (§2.5).
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import {
  selectActiveHealth,
  selectContext,
  selectCost,
  selectFailover,
  selectProviderHealth,
} from "../store/selectors.js";
import type { ProviderHealth, ViewState } from "../store/viewState.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle, type InkTextStyle } from "../theme/ThemeProvider.js";

export interface StatusHudProps {
  view: ViewState;
  cols: number;
  /** Real context window (engine-owned); the HUD never invents it. */
  contextMax?: number;
  /** Force the compact tier regardless of width (narrow / short terminals). */
  forceCompact?: boolean;
}

/** Compact a token count: `84200 → 84.2k`. */
export function formatTokens(n: number): string {
  if (n < 1000) return `${n}`;
  return `${(n / 1000).toFixed(1)}k`;
}

/** Build a fixed-width `▓▓░░` context bar. */
export function buildBar(pct: number, width: number, full: string, empty: string): string {
  const filled = Math.round(Math.min(1, Math.max(0, pct)) * width);
  return full.repeat(filled) + empty.repeat(Math.max(0, width - filled));
}

function costStyleFor(pct: number, ok: InkTextStyle, warn: InkTextStyle, crit: InkTextStyle): InkTextStyle {
  if (pct >= 0.9) return crit;
  if (pct >= 0.75) return warn;
  return ok;
}

function HealthDot({
  health,
  active,
  showName = false,
}: {
  health: ProviderHealth;
  active: boolean;
  showName?: boolean;
}): React.JSX.Element {
  const caps = useCaps();
  const style = useTextStyle(providerToken(health.provider));
  return (
    <Text {...style}>
      {active ? glyph(caps, "dotFilled") : glyph(caps, "dotHollow")}
      {providerLetter(health.provider)} {showName ? `${health.provider} ` : ""}
      {health.note}
    </Text>
  );
}

export function StatusHud({ view, cols, contextMax = 200000, forceCompact = false }: StatusHudProps): React.JSX.Element {
  const caps = useCaps();
  const muted = useTextStyle("text.muted");
  const accent = useTextStyle("accent.default");
  const costOk = useTextStyle("cost.ok");
  const costWarn = useTextStyle("cost.warn");
  const costCrit = useTextStyle("cost.crit");
  const boltStyle = useTextStyle("warning.fg");

  const ctx = selectContext(view, contextMax);
  const { sessionUsd, runUsd } = selectCost(view);
  const active = selectActiveHealth(view);
  const health = selectProviderHealth(view);
  const failover = selectFailover(view);

  const barFull = glyph(caps, "barFull");
  const barEmpty = glyph(caps, "barEmpty");
  const tier1 = !forceCompact && cols >= 120;
  const barWidth = tier1 ? 14 : 10;

  const costStyle = costStyleFor(ctx.pct, costOk, costWarn, costCrit);
  const sep = ` ${caps.unicode ? "·" : "-"} `;

  const contextSegment = (
    <Text>
      <Text {...muted}>ctx </Text>
      <Text {...accent}>
        {formatTokens(ctx.used)}/{formatTokens(ctx.max)}{" "}
      </Text>
      <Text {...accent}>{buildBar(ctx.pct, barWidth, barFull, barEmpty)}</Text>
    </Text>
  );

  if (!tier1) {
    // Tier 0 — single line.
    return (
      <Box>
        {contextSegment}
        <Text {...muted}>{sep}</Text>
        <Text {...costStyle}>${sessionUsd.toFixed(2)}</Text>
        {active ? (
          <Text>
            <Text {...muted}>{sep}</Text>
            <HealthDot health={active} active />
          </Text>
        ) : null}
        <Text {...muted}> </Text>
        <Text {...boltStyle}>
          {glyph(caps, "bolt")}
          {failover ? "!" : "?"}
        </Text>
      </Box>
    );
  }

  // Tier 1 — two rows.
  return (
    <Box flexDirection="column">
      <Box>{contextSegment}</Box>
      <Box>
        <Text {...costStyle}>${sessionUsd.toFixed(2)} session</Text>
        <Text {...muted}>{sep}</Text>
        <Text {...costOk}>${runUsd.toFixed(2)} run</Text>
        {health.map((h) => (
          <Text key={h.provider}>
            <Text {...muted}>{sep}</Text>
            <HealthDot health={h} active={h.provider === active?.provider} showName />
          </Text>
        ))}
        {failover ? (
          <Text>
            <Text {...muted}>{sep}</Text>
            <Text {...boltStyle}>{glyph(caps, "bolt")} failover</Text>
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}
