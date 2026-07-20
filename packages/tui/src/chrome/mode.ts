/**
 * Interaction mode (design spec §6.3). The Shift+Tab ring is 4 states —
 * CHAT → PLAN → AGENT → AUTOPILOT (wraps). COMPARE is a *layout*, not a ring
 * member, so it is accepted for display but excluded from `nextMode`.
 */

export type UiMode = "CHAT" | "PLAN" | "AGENT" | "AUTOPILOT" | "COMPARE";

/** The ordered mode ring (COMPARE excluded, §6.3). */
export const MODE_RING: readonly UiMode[] = ["CHAT", "PLAN", "AGENT", "AUTOPILOT"];

/** Advance the ring (Shift+Tab). COMPARE resets into the ring at CHAT. */
export function nextMode(mode: UiMode): UiMode {
  const i = MODE_RING.indexOf(mode);
  if (i === -1) return "CHAT";
  return MODE_RING[(i + 1) % MODE_RING.length]!;
}

/** Reverse the ring (Shift+Shift+Tab). */
export function prevMode(mode: UiMode): UiMode {
  const i = MODE_RING.indexOf(mode);
  if (i === -1) return "AUTOPILOT";
  return MODE_RING[(i - 1 + MODE_RING.length) % MODE_RING.length]!;
}
