/**
 * Height estimation for a rendered turn.
 *
 * Mode B tiles panes into a fixed region, so a pane that holds an unbounded
 * transcript will outgrow its neighbours and leave the row with a ragged bottom
 * edge. Ink gives us no way to clip after the fact — a fixed `height` overlays
 * the surplus rows and corrupts the text rather than cutting it — so the only
 * safe place to bound the content is *before* rendering it.
 *
 * These functions mirror the wrapping rules `<MessageView>` and `<Markdown>`
 * actually apply, closely enough to pick how many trailing turns fit. They are
 * an estimate, not a guarantee: `<PaneFrame>` uses `minHeight`, so being a row
 * or two out makes a pane slightly tall — never garbled.
 */

import { parseMarkdown } from "../components/Markdown.js";
import type { Turn } from "../store/viewState.js";
import { GUTTER } from "./MessageView.js";

/** Rows a soft-wrapped paragraph of `text` occupies at `width` columns. */
function wrappedRows(text: string, width: number): number {
  if (width <= 0) return 1;
  let rows = 0;
  for (const line of text.split("\n")) {
    rows += Math.max(1, Math.ceil(line.length / width));
  }
  return rows;
}

/** Rows the Markdown body of `content` occupies at `width` columns. */
export function estimateMarkdownRows(content: string, width: number): number {
  const blocks = parseMarkdown(content);
  let rows = 0;
  blocks.forEach((b, i) => {
    if (i > 0) rows += 1; // the blank line every block after the first carries
    switch (b.kind) {
      case "heading":
        rows += wrappedRows(b.text, width);
        break;
      case "paragraph":
        rows += wrappedRows(b.text, width);
        break;
      case "code":
        // The left rule + padding costs 2 columns of wrap width.
        rows += wrappedRows(b.code, Math.max(1, width - 2));
        break;
      case "list":
        for (const item of b.items) rows += wrappedRows(item, Math.max(1, width - 2));
        break;
      case "quote":
        rows += wrappedRows(b.text, Math.max(1, width - 2));
        break;
      case "rule":
        rows += 1;
        break;
      case "table":
        rows += 2 + b.rows.length;
        break;
    }
  });
  return rows;
}

/** Rows one `<MessageView>` occupies at `width` columns, margin included. */
export function estimateTurnRows(turn: Turn, width: number, streaming = false): number {
  const body = Math.max(1, width - GUTTER);
  let rows = 0;
  if (turn.reasoning) rows += wrappedRows(turn.reasoning, body);
  if (turn.text) rows += estimateMarkdownRows(turn.text, body);
  if (!turn.reasoning && !turn.text) rows += 1; // the "thinking" placeholder
  if (streaming && turn.text) rows += 1; // the trailing <StreamingCursor> row
  rows += turn.tools.length + turn.diffs.length;
  return rows + 1; // marginBottom
}

/**
 * The trailing slice of `turns` that fits in `maxRows`, newest-biased. Always
 * returns at least the last turn — showing a truncated final answer beats
 * showing an empty pane.
 */
export function fitTrailingTurns(
  turns: readonly Turn[],
  width: number,
  maxRows: number,
): readonly Turn[] {
  if (turns.length === 0 || maxRows <= 0) return turns;
  let used = 0;
  let start = turns.length;
  for (let i = turns.length - 1; i >= 0; i--) {
    const cost = estimateTurnRows(turns[i]!, width);
    if (used + cost > maxRows && start < turns.length) break;
    used += cost;
    start = i;
    if (used >= maxRows) break;
  }
  return turns.slice(start);
}
