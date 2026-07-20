/**
 * `<CostMeter>` (design spec §2.5, §3.7) — `$session · $run` spend, ramping
 * `cost.ok → cost.warn → cost.crit` at 0.75 / 0.9 of the spend cap. On/over the
 * cap it shows `▲ cap $5.00 — degrading` (the engine degrades gracefully, never a
 * hard mid-token stop). With no cap it stays `cost.ok`. Pure `costTier` helper is
 * headless-testable.
 */

import { Text } from "ink";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { Icon } from "./Icon.js";

export type CostTier = "ok" | "warn" | "crit";

/** Spend tier vs the cap (0.75 warn, 0.9 crit). No cap → always `ok`. */
export function costTier(spentUsd: number, cap?: number): CostTier {
  if (cap === undefined || cap <= 0) return "ok";
  const pct = spentUsd / cap;
  if (pct >= 0.9) return "crit";
  if (pct >= 0.75) return "warn";
  return "ok";
}

export interface CostMeterProps {
  sessionUsd: number;
  runUsd?: number;
  /** Spend cap; drives the tier ramp + the `▲ cap` degrade notice. */
  cap?: number;
  /** Show the `· $run` segment. Default true when `runUsd` is provided. */
  showRun?: boolean;
  measure?: (s: string) => number;
}

export function CostMeter({
  sessionUsd,
  runUsd,
  cap,
  showRun = true,
  measure,
}: CostMeterProps): React.JSX.Element {
  const tier = costTier(sessionUsd, cap);
  const ok = useTextStyle("cost.ok");
  const warn = useTextStyle("cost.warn");
  const crit = useTextStyle("cost.crit");
  const muted = useTextStyle("text.muted");
  const style = tier === "crit" ? crit : tier === "warn" ? warn : ok;
  const overCap = cap !== undefined && cap > 0 && sessionUsd >= cap;
  const hasRun = showRun && runUsd !== undefined;

  return (
    <Text>
      <Text {...style}>${sessionUsd.toFixed(2)} session</Text>
      {hasRun ? (
        <Text>
          <Text {...muted}> · </Text>
          <Text {...ok}>${(runUsd ?? 0).toFixed(2)} run</Text>
        </Text>
      ) : null}
      {overCap ? (
        <Text {...crit}>
          {"  "}
          <Icon name="warn" style={crit} {...(measure ? { measure } : {})} /> cap ${cap!.toFixed(2)} — degrading
        </Text>
      ) : null}
    </Text>
  );
}
