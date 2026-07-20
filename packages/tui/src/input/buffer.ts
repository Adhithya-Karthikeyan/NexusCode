/**
 * Multiline input buffer (design spec §6.7) — the *only* TUI-local truth
 * (§10.4-1). A pure, immutable value: every op returns a new buffer, so it is
 * trivially unit-testable with zero Ink/React. Rows are wrapped-agnostic logical
 * lines; the view soft-wraps for display.
 */

export interface Buffer {
  readonly lines: readonly string[];
  readonly row: number;
  readonly col: number;
}

/** Empty single-line buffer. */
export const emptyBuffer: Buffer = { lines: [""], row: 0, col: 0 };

/** Construct a buffer from text with the cursor at the end. */
export function fromText(text: string): Buffer {
  const lines = text.split("\n");
  const row = lines.length - 1;
  return { lines, row, col: (lines[row] ?? "").length };
}

/** Flatten to a submittable string. */
export function toText(b: Buffer): string {
  return b.lines.join("\n");
}

export function isEmpty(b: Buffer): boolean {
  return b.lines.length === 1 && b.lines[0] === "";
}

export function isSingleLine(b: Buffer): boolean {
  return b.lines.length === 1;
}

function clampCol(line: string, col: number): number {
  return Math.max(0, Math.min(col, line.length));
}

/** Insert printable text at the cursor (may contain no newlines). */
export function insert(b: Buffer, text: string): Buffer {
  if (text.includes("\n")) return insertMultiline(b, text);
  const line = b.lines[b.row] ?? "";
  const col = clampCol(line, b.col);
  const next = line.slice(0, col) + text + line.slice(col);
  const lines = b.lines.slice();
  lines[b.row] = next;
  return { lines, row: b.row, col: col + text.length };
}

/** Insert text that itself contains newlines (a paste). */
export function insertMultiline(b: Buffer, text: string): Buffer {
  const parts = text.split("\n");
  const line = b.lines[b.row] ?? "";
  const col = clampCol(line, b.col);
  const head = line.slice(0, col);
  const tail = line.slice(col);
  const firstPart = parts[0] ?? "";
  const merged: string[] = [head + firstPart, ...parts.slice(1)];
  const lastIdx = merged.length - 1;
  const lastCore = merged[lastIdx] ?? "";
  merged[lastIdx] = lastCore + tail;
  const lines = [...b.lines.slice(0, b.row), ...merged, ...b.lines.slice(b.row + 1)];
  const newRow = b.row + parts.length - 1;
  return { lines, row: newRow, col: lastCore.length };
}

/** Split the current line at the cursor (Alt+Enter newline). */
export function newline(b: Buffer): Buffer {
  const line = b.lines[b.row] ?? "";
  const col = clampCol(line, b.col);
  const lines = [
    ...b.lines.slice(0, b.row),
    line.slice(0, col),
    line.slice(col),
    ...b.lines.slice(b.row + 1),
  ];
  return { lines, row: b.row + 1, col: 0 };
}

/** Delete the char before the cursor (joins lines at column 0). */
export function backspace(b: Buffer): Buffer {
  const line = b.lines[b.row] ?? "";
  if (b.col > 0) {
    const next = line.slice(0, b.col - 1) + line.slice(b.col);
    const lines = b.lines.slice();
    lines[b.row] = next;
    return { lines, row: b.row, col: b.col - 1 };
  }
  if (b.row === 0) return b;
  const prev = b.lines[b.row - 1] ?? "";
  const merged = prev + line;
  const lines = [...b.lines.slice(0, b.row - 1), merged, ...b.lines.slice(b.row + 1)];
  return { lines, row: b.row - 1, col: prev.length };
}

/** Kill from the cursor to the end of the line (Ctrl+K). */
export function killToLineEnd(b: Buffer): Buffer {
  const line = b.lines[b.row] ?? "";
  const lines = b.lines.slice();
  lines[b.row] = line.slice(0, b.col);
  return { lines, row: b.row, col: b.col };
}

/** Kill from line start to the cursor (Ctrl+U). */
export function killToLineStart(b: Buffer): Buffer {
  const line = b.lines[b.row] ?? "";
  const lines = b.lines.slice();
  lines[b.row] = line.slice(b.col);
  return { lines, row: b.row, col: 0 };
}

/** Delete the word before the cursor (Ctrl+W). */
export function deleteWordLeft(b: Buffer): Buffer {
  const line = b.lines[b.row] ?? "";
  let i = b.col;
  while (i > 0 && /\s/.test(line[i - 1] ?? "")) i -= 1;
  while (i > 0 && !/\s/.test(line[i - 1] ?? "")) i -= 1;
  const lines = b.lines.slice();
  lines[b.row] = line.slice(0, i) + line.slice(b.col);
  return { lines, row: b.row, col: i };
}

export function moveLeft(b: Buffer): Buffer {
  if (b.col > 0) return { ...b, col: b.col - 1 };
  if (b.row > 0) return { ...b, row: b.row - 1, col: (b.lines[b.row - 1] ?? "").length };
  return b;
}

export function moveRight(b: Buffer): Buffer {
  const line = b.lines[b.row] ?? "";
  if (b.col < line.length) return { ...b, col: b.col + 1 };
  if (b.row < b.lines.length - 1) return { ...b, row: b.row + 1, col: 0 };
  return b;
}

export function moveLineStart(b: Buffer): Buffer {
  return { ...b, col: 0 };
}

export function moveLineEnd(b: Buffer): Buffer {
  return { ...b, col: (b.lines[b.row] ?? "").length };
}

export function moveUp(b: Buffer): Buffer {
  if (b.row === 0) return b;
  const target = b.lines[b.row - 1] ?? "";
  return { ...b, row: b.row - 1, col: Math.min(b.col, target.length) };
}

export function moveDown(b: Buffer): Buffer {
  if (b.row >= b.lines.length - 1) return b;
  const target = b.lines[b.row + 1] ?? "";
  return { ...b, row: b.row + 1, col: Math.min(b.col, target.length) };
}

/** True when the cursor is on the first logical line (history-up boundary, §6.7). */
export function atFirstLine(b: Buffer): boolean {
  return b.row === 0;
}

/** True when the cursor is on the last logical line (history-down boundary). */
export function atLastLine(b: Buffer): boolean {
  return b.row === b.lines.length - 1;
}

/**
 * Whether the buffer has an unclosed triple-backtick fence — single-Enter submit
 * is disabled while a fence is open (§6.2 open-fence awareness).
 */
export function hasOpenFence(b: Buffer): boolean {
  const fences = toText(b).match(/```/g);
  return fences !== null && fences.length % 2 === 1;
}
