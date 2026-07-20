/**
 * `<StreamingCursor>` — the in-flight streaming cursor (design spec §3.2, §7).
 *
 * The block caret `▍` that trails live-streaming text. Motion is *information*:
 * it exists only while a turn is streaming, and it honors the motion tier (§7):
 *
 * - `full`    — blinks at ~530 ms (spec §7 "Stream cursor · 530 ms blink").
 * - `reduced` — a static block `▮`, no blink (also for sighted low-vision users).
 * - `none`    — a static block, no timer at all (screen-reader / dumb term).
 *
 * Pure renderer: it holds no business state, only the local blink phase, and it
 * tears its timer down on unmount so it never leaks past a finished stream.
 */

import { Text } from "ink";
import { useEffect, useState } from "react";
import { useCaps } from "../caps/CapabilityProvider.js";
import { useTextStyle } from "../theme/ThemeProvider.js";
import { animates, useMotionTier } from "./motion.js";

export interface StreamingCursorProps {
  /** Whether the stream is live. When `false`, nothing renders. */
  active?: boolean;
  /** Blink period in ms at the `full` tier (spec default 530). */
  blinkMs?: number;
}

/** The blinking / static caret appended to streaming text. */
export function StreamingCursor({ active = true, blinkMs = 530 }: StreamingCursorProps): React.JSX.Element | null {
  const caps = useCaps();
  const tier = useMotionTier();
  const style = useTextStyle("stream.cursor");
  const [visible, setVisible] = useState(true);

  const shouldBlink = active && animates(tier);
  useEffect(() => {
    if (!shouldBlink) {
      setVisible(true);
      return;
    }
    const id = setInterval(() => setVisible((v) => !v), blinkMs);
    return () => clearInterval(id);
  }, [shouldBlink, blinkMs]);

  if (!active) return null;

  // `▍` blinking at full tier; `▮` static otherwise. ASCII terminals get `|`.
  const blinkGlyph = caps.unicode ? "▍" : "|";
  const staticGlyph = caps.unicode ? "▮" : "|";
  const glyph = animates(tier) ? blinkGlyph : staticGlyph;
  // Keep width stable across blink frames so text does not reflow.
  const shown = animates(tier) && !visible ? " " : glyph;

  return <Text {...style}>{shown}</Text>;
}
