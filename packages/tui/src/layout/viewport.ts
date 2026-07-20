/**
 * Mode B viewport engine (design spec §2.0, §10.3). Alt-screen mode forfeits
 * native scrollback, so the TUI owns a manual line-window: given a total line
 * count, a window height, and a scroll offset, it computes the visible range and
 * an in-app scrollbar thumb (§3.1). This is the pure math the viewport renderer
 * sits on; the full ratatui-style cell repaint is a later wave, but the windowing
 * contract is frozen here so Mode A↔B switches cleanly.
 */

export interface LineWindow {
  /** First visible line index (inclusive). */
  start: number;
  /** One past the last visible line index (exclusive). */
  end: number;
  /** Clamped scroll offset actually used. */
  offset: number;
  /** Whether content overflows the window (scrollbar shown only then). */
  overflow: boolean;
}

/**
 * Compute the visible line range. `offset` counts lines scrolled up from the
 * bottom (0 = pinned to tail, the sticky-bottom default of §6.8). Always returns
 * a valid, clamped window — never negative, never past the content.
 */
export function computeLineWindow(total: number, height: number, offset: number): LineWindow {
  const h = Math.max(0, Math.floor(height));
  const t = Math.max(0, Math.floor(total));
  if (t <= h) {
    return { start: 0, end: t, offset: 0, overflow: false };
  }
  const maxOffset = t - h;
  const clamped = Math.min(Math.max(0, Math.floor(offset)), maxOffset);
  const end = t - clamped;
  const start = end - h;
  return { start, end, offset: clamped, overflow: true };
}

export interface ScrollThumb {
  /** Thumb size in rows (≥1). */
  size: number;
  /** Thumb top position (0-based row within the track). */
  position: number;
}

/** Scrollbar thumb geometry for a window (§3.1: `max(1, round(view/total*height))`). */
export function scrollThumb(total: number, height: number, offset: number): ScrollThumb {
  const h = Math.max(1, Math.floor(height));
  const t = Math.max(1, Math.floor(total));
  if (t <= h) return { size: h, position: 0 };
  const size = Math.max(1, Math.round((h / t) * h));
  const maxOffset = t - h;
  const clamped = Math.min(Math.max(0, offset), maxOffset);
  // offset 0 = bottom → thumb at the bottom of the track.
  const linesFromTop = maxOffset - clamped;
  const travel = h - size;
  const position = maxOffset === 0 ? 0 : Math.round((linesFromTop / maxOffset) * travel);
  return { size, position };
}
