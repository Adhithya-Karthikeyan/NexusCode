/**
 * Motion tier resolution (design spec §7 "Motion & Delight", §8.5 reviewer fix).
 *
 * Motion is *information, never decoration* (§1.1-5): every animated component
 * reads a single **motion tier** and renders a static terminal frame when motion
 * is off. The tier is derived once from the resolved terminal capabilities so no
 * component pokes at `process.env` or invents its own animation policy.
 *
 * - `full`   — animate (cursor blink, braille spinner, shimmer). The calm default
 *              on a capable interactive terminal.
 * - `reduced`— `prefers-reduced-motion` / `NEXUS_REDUCED_MOTION`: static glyph +
 *              textual status, no blink, no shimmer — for sighted low-vision users
 *              too, not only screen readers (§7 reviewer fix).
 * - `none`   — screen-reader / `TERM=dumb` / non-TTY: no animation whatsoever;
 *              components emit a single stable frame.
 */

import { useCaps } from "../caps/CapabilityProvider.js";
import type { Capabilities } from "../caps/capabilities.js";

/** The three motion tiers (§7). */
export type MotionTier = "full" | "reduced" | "none";

/** The capability slice the motion tier depends on. */
export type MotionCaps = Pick<
  Capabilities,
  "reducedMotion" | "screenReader" | "termDumb" | "isTTY"
>;

/**
 * Derive the motion tier from capabilities. Screen-reader / dumb-term / non-TTY
 * collapse to `none` (a single static frame is the only correct output there);
 * `reducedMotion` maps to `reduced`; everything else animates (`full`).
 */
export function motionTier(caps: MotionCaps): MotionTier {
  if (caps.screenReader || caps.termDumb || caps.isTTY === false) return "none";
  if (caps.reducedMotion) return "reduced";
  return "full";
}

/** Whether a component may run a timer-driven animation at this tier. */
export function animates(tier: MotionTier): boolean {
  return tier === "full";
}

/** Hook form: the active motion tier for the current terminal. */
export function useMotionTier(): MotionTier {
  return motionTier(useCaps());
}
