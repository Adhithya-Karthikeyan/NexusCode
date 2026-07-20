/**
 * `<ModelBadge>` (design spec §2.3, §3.7) — the served model with its provider
 * hue dot and letter tag: `●A Opus 4.8 (anthropic)`. The model shown is the
 * **verified** served model (anti-substitution); `verified=false` appends a
 * `⚠ unverified` warning. Attribution is always carried by the letter + name, not
 * color alone (§1.3.2).
 */

import { Text } from "ink";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { Icon } from "./Icon.js";

export interface ModelBadgeProps {
  model: string;
  provider: string;
  /** Verified served model (§2.3). Defaults to true; false → `⚠ unverified`. */
  verified?: boolean;
  /** Show `(provider)` after the model name. Default true. */
  showProvider?: boolean;
  /** Filled (active) vs hollow (available) dot. Default filled. */
  active?: boolean;
  measure?: (s: string) => number;
}

export function ModelBadge({
  model,
  provider,
  verified = true,
  showProvider = true,
  active = true,
  measure,
}: ModelBadgeProps): React.JSX.Element {
  const hue = useTextStyle(providerToken(provider));
  const name = useTextStyle("chrome.title");
  const warn = useTextStyle("warning.fg");
  return (
    <Text>
      <Icon name={active ? "dotFilled" : "dotHollow"} style={hue} {...(measure ? { measure } : {})} />
      <Text {...hue}>{providerLetter(provider)} </Text>
      <Text {...name}>{model}</Text>
      {showProvider ? <Text {...hue}> ({provider})</Text> : null}
      {verified ? null : (
        <Text {...warn}>
          {" "}
          <Icon name="warn" style={warn} {...(measure ? { measure } : {})} /> unverified
        </Text>
      )}
    </Text>
  );
}
