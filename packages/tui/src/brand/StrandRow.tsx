/**
 * `<StrandRow>` — the signature brand gesture (design spec §1.2): five provider
 * dots as converging fibers into the node `●────●──◆──●────●`. Reused in the
 * splash, onboarding, About, and the compare header. Each provider dot carries its
 * own hue + a redundant letter tag (`A O G X L`) so attribution survives no-color.
 */

import { Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph } from "../caps/glyphs.js";
import { providerLetter, providerToken } from "../theme/providerToken.js";
import { useTextStyle } from "../theme/ThemeProvider.js";

/** The five headline providers shown as strands (converging into the node). */
const STRAND_PROVIDERS = ["anthropic", "openai", "google", "xai", "ollama"] as const;

export interface StrandRowProps {
  /** Show the redundant provider letters under the dots (no-color attribution). */
  showLetters?: boolean;
}

function Dot({ provider }: { provider: string }): React.JSX.Element {
  const caps = useCaps();
  const hue = useTextStyle(providerToken(provider));
  return <Text {...hue}>{glyph(caps, "dotFilled")}</Text>;
}

export function StrandRow({ showLetters = true }: StrandRowProps): React.JSX.Element {
  const caps = useCaps();
  const node = useTextStyle("accent.default");
  const muted = useTextStyle("text.muted");
  const fiber = caps.unicode ? "────" : "----";
  const shortFiber = caps.unicode ? "──" : "--";

  return (
    <Text>
      <Dot provider={STRAND_PROVIDERS[0]} />
      <Text {...muted}>{fiber}</Text>
      <Dot provider={STRAND_PROVIDERS[1]} />
      <Text {...muted}>{shortFiber}</Text>
      <Text {...node}>{glyph(caps, "node")}</Text>
      <Text {...muted}>{shortFiber}</Text>
      <Dot provider={STRAND_PROVIDERS[2]} />
      <Text {...muted}>{fiber}</Text>
      <Dot provider={STRAND_PROVIDERS[3]} />
      <Text {...muted}>{shortFiber}</Text>
      <Dot provider={STRAND_PROVIDERS[4]} />
      {showLetters ? (
        <Text {...muted}>
          {"  "}
          {STRAND_PROVIDERS.map((p) => providerLetter(p)).join(" ")}
        </Text>
      ) : null}
    </Text>
  );
}
