/**
 * Interrupt & hard-stop ladder (design spec §6.6) — "the stop button actually
 * stops". `Esc` requests a graceful interrupt; a second bare `Esc` within 400 ms
 * escalates to a hard stop. The window is tuned to *not* swallow legit
 * arrow/meta escape sequences (§6.6 disambiguation): only a bare repeat escalates.
 * Pure + time-injectable.
 */

/** The double-tap escalation window (§6.4). */
export const ESC_ESC_WINDOW_MS = 400;

export type InterruptMode = "graceful" | "hard";

export interface EscVerdict {
  mode: InterruptMode;
  /** Timestamp to carry forward (0 after a hard stop resets the ladder). */
  nextEscTs: number;
}

/**
 * Classify an `Esc` press given the previous bare-`Esc` timestamp. First press →
 * graceful; a second within the window → hard (and resets the ladder so a third
 * press starts fresh).
 */
export function classifyEsc(lastEscTs: number, now: number): EscVerdict {
  if (lastEscTs > 0 && now - lastEscTs <= ESC_ESC_WINDOW_MS) {
    return { mode: "hard", nextEscTs: 0 };
  }
  return { mode: "graceful", nextEscTs: now };
}

/** Ctrl+C ladder: one within 2 s = interrupt, a second = quit-confirm (§6.4). */
export const CTRL_C_WINDOW_MS = 2000;

export type CtrlCMode = "interrupt" | "quit-confirm";

export function classifyCtrlC(lastCtrlCTs: number, now: number): { mode: CtrlCMode; nextTs: number } {
  if (lastCtrlCTs > 0 && now - lastCtrlCTs <= CTRL_C_WINDOW_MS) {
    return { mode: "quit-confirm", nextTs: 0 };
  }
  return { mode: "interrupt", nextTs: now };
}
