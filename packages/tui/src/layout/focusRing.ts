/**
 * The focus ring (design spec §2.7). One ordered list of focusable leaf ids
 * derived from the tree in reading order (top→bottom, left→right). `<Workspace>`
 * owns `focusedId`; this module is the pure derivation + navigation.
 */

import { collectLeaves, type PaneNode } from "./tree.js";

/** Ordered focusable leaf ids (reading order, active-stack-child only). */
export function deriveFocusRing(root: PaneNode): string[] {
  return collectLeaves(root)
    .filter((l) => l.focusable)
    .map((l) => l.id);
}

/** Next focusable id after `current` (wraps). Falls back to the first id. */
export function nextFocus(ring: readonly string[], current: string | null): string | null {
  if (ring.length === 0) return null;
  if (current === null) return ring[0] ?? null;
  const i = ring.indexOf(current);
  if (i === -1) return ring[0] ?? null;
  return ring[(i + 1) % ring.length] ?? null;
}

/** Previous focusable id before `current` (wraps). */
export function prevFocus(ring: readonly string[], current: string | null): string | null {
  if (ring.length === 0) return null;
  if (current === null) return ring[ring.length - 1] ?? null;
  const i = ring.indexOf(current);
  if (i === -1) return ring[ring.length - 1] ?? null;
  return ring[(i - 1 + ring.length) % ring.length] ?? null;
}

/** Clamp a stored focus id to one still present in the ring (after a resize). */
export function reconcileFocus(ring: readonly string[], current: string | null): string | null {
  if (current !== null && ring.includes(current)) return current;
  return ring[0] ?? null;
}
