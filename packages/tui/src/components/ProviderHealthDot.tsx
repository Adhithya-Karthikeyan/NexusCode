/**
 * `<ProviderHealthDot>` (design spec §2.5, §3.7) — one provider strand's live
 * health, derived passively from real request outcomes (never background polling).
 * Renders `●A anthropic ok·3s`: a hue-coded dot (filled=active, hollow=available)
 * **plus** a letter tag **plus** the status word — health is never color-only
 * (§1.3.2). An optional staleness cue (`·Ns`) shows how old the last outcome is.
 */

import { Text } from "ink";
import type { ProviderHealth } from "../store/viewState.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { Icon } from "./Icon.js";

export interface ProviderHealthDotProps {
  health: ProviderHealth;
  /** Filled dot when this is the active provider; hollow when merely available. */
  active?: boolean;
  /** Include the provider name (`anthropic`) after the letter tag. */
  showName?: boolean;
  /** Current time for the `·Ns` staleness cue; omit to hide it. */
  nowTs?: number;
  /** Width oracle passed to the dot glyph (boot probe). */
  measure?: (s: string) => number;
}

/** Human staleness cue: `3s`, `2m`, `1h`. */
export function staleness(lastTs: number, nowTs: number): string {
  const ms = Math.max(0, nowTs - lastTs);
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export function ProviderHealthDot({
  health,
  active = false,
  showName = false,
  nowTs,
  measure,
}: ProviderHealthDotProps): React.JSX.Element {
  const hue = useTextStyle(providerToken(health.provider));
  const cue = nowTs !== undefined && (health.status === "ok" || health.status === "warm")
    ? `·${staleness(health.lastTs, nowTs)}`
    : "";
  const word = health.note || health.status;
  return (
    <Text>
      <Icon name={active ? "dotFilled" : "dotHollow"} style={hue} {...(measure ? { measure } : {})} />
      <Text {...hue}>{providerLetter(health.provider)}</Text>
      <Text {...hue}>
        {" "}
        {showName ? `${health.provider} ` : ""}
        {word}
        {cue}
      </Text>
    </Text>
  );
}
