/**
 * `<TypingIndicator>` — the "thinking / typing" narrating spinner (design spec
 * §3.8 `<Spinner>`, §7). Motion is *never bare*: it is always `<glyph> <label>`
 * so a screen reader / no-color / dumb terminal still reads the state (§7
 * "`<ActivitySpinner>` is never bare"). Honors the motion tier:
 *
 * - `full`    — braille frames `⠋⠙⠹…` cycle at ~80 ms.
 * - `reduced` — a static ellipsis `⋯`, no animation.
 * - `none`    — static ellipsis + label only (screen-reader announces the label).
 *
 * The metric/label is a prop (the engine owns the number); the component never
 * fabricates a rate. Empty label is allowed but discouraged — callers should pass
 * a verb like "thinking" or "streaming 142 tok/s".
 */

import { Text } from "ink";
import { useEffect, useState } from "react";
import { useCaps } from "../caps/CapabilityProvider.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { animates, useMotionTier } from "./motion.js";

/** Braille spinner frames (§7 "braille `⠋⠙⠹…`"). */
const BRAILLE = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export interface TypingIndicatorProps {
  /** The narration shown after the glyph (verb + optional live metric). */
  label?: string;
  /** Whether the indicator is active. When `false`, nothing renders. */
  active?: boolean;
  /** Frame period in ms at the `full` tier (spec default 80). */
  frameMs?: number;
}

/** The thinking/typing indicator (glyph + always-present textual status). */
export function TypingIndicator({
  label = "thinking",
  active = true,
  frameMs = 80,
}: TypingIndicatorProps): React.JSX.Element | null {
  const caps = useCaps();
  const tier = useMotionTier();
  const glyphStyle = useTextStyle("spinner");
  const labelStyle = useTextStyle("stream.thinking");
  const [frame, setFrame] = useState(0);

  const shouldAnimate = active && animates(tier) && caps.unicode;
  useEffect(() => {
    if (!shouldAnimate) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % BRAILLE.length), frameMs);
    return () => clearInterval(id);
  }, [shouldAnimate, frameMs]);

  if (!active) return null;

  // Static glyph when motion is off (or no unicode): the ellipsis carries meaning.
  const glyph = shouldAnimate ? BRAILLE[frame]! : caps.unicode ? "⋯" : "...";

  return (
    <Text>
      <Text {...glyphStyle}>{glyph}</Text>
      {label ? <Text {...labelStyle}> {label}</Text> : null}
    </Text>
  );
}
