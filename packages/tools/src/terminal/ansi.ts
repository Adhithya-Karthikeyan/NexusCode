/**
 * ANSI-aware helpers for terminal streaming. The streaming passthrough
 * (ProcessManager / Pty) deliberately delivers raw bytes so escape sequences
 * (colors, cursor moves) survive intact for a real terminal renderer. These
 * helpers are for consumers that want a *plain* view instead.
 */

/**
 * Matches ANSI escape sequences: CSI (`ESC [ … final`), OSC (`ESC ] … BEL/ST`),
 * and single-char escapes. Kept as one source-shared regex; callers that need a
 * global matcher construct their own from `ANSI_PATTERN` to avoid `lastIndex`
 * state bleed.
 */
export const ANSI_PATTERN =
  "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))";

/** Remove all ANSI escape sequences from `s`. */
export function stripAnsi(s: string): string {
  return s.replace(new RegExp(ANSI_PATTERN, "g"), "");
}

/** True when `s` contains at least one ANSI escape sequence. */
export function hasAnsi(s: string): boolean {
  return new RegExp(ANSI_PATTERN).test(s);
}
