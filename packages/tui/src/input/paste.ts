/**
 * Bracketed-paste guard (design spec §1.1 law #1, §6.2). "Never fire half-written":
 * a stray Enter inside a multi-line paste must never dispatch a turn. Ink coalesces
 * a paste into a single `useInput` call, so a chunk that is multi-char *and* arrives
 * as a burst (or contains a newline) is paste content — inserted literally, never
 * submitted. Pure + time-injectable for deterministic tests.
 */

/** Chunks arriving closer than this (ms) are treated as one paste burst (§2.4). */
export const PASTE_BURST_MS = 30;

export interface PasteState {
  /** Timestamp of the last input chunk. */
  lastTs: number;
  /** Whether we are currently inside a paste burst. */
  active: boolean;
}

export const initialPasteState: PasteState = { lastTs: 0, active: false };

export interface PasteVerdict {
  /** This chunk is paste content — insert literally, do not submit. */
  isPaste: boolean;
  next: PasteState;
}

/**
 * Classify an input chunk. A chunk is paste when it contains a newline, is
 * multi-character, or continues a burst started <30 ms ago. A lone printable
 * char after the burst quiets ends the paste.
 */
export function classifyInput(state: PasteState, input: string, now: number): PasteVerdict {
  const multiChar = input.length > 1;
  // A newline only signals paste when embedded in a multi-char chunk. A lone
  // "\r"/"\n" is the Enter keystroke itself (the submit key), never paste — Ink
  // delivers a bare Enter as a single-character "\r" and coalesces a real
  // bracketed paste into one multi-character chunk.
  const containsNewline = multiChar && (input.includes("\n") || input.includes("\r"));
  const withinBurst = state.active && now - state.lastTs < PASTE_BURST_MS;
  const isPaste = multiChar || containsNewline || withinBurst;
  return {
    isPaste,
    next: { lastTs: now, active: isPaste },
  };
}

/** Quick, stateless check: does this chunk *look* like a paste on its own? */
export function looksLikePaste(input: string): boolean {
  // Only a multi-character chunk is a paste. A single character — including a
  // lone Enter ("\r") or newline ("\n") — is a keystroke and must fall through
  // to the submit/newline logic, else Enter can never send (design §6.2).
  return input.length > 1;
}
