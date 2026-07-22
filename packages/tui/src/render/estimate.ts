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

/** How a body of text is measured: `(text, width) → rows`. */
type Measure = (text: string, width: number) => number;

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

/** Rows one `<UserPrompt>` occupies at `width` columns, margin included. */
export function estimatePromptRows(text: string, width: number): number {
  return wrappedRows(text, Math.max(1, width - GUTTER)) + 1; // marginBottom
}

/**
 * The trailing slice of `content` that measures within `maxRows`.
 *
 * The search is a binary search over the number of trailing LINES, verified
 * afterwards: `measure` is not strictly monotonic in the line count (cutting
 * into a fenced code block leaves the closing fence opening an unterminated one,
 * so the tail re-parses as a single long code block), and a bound that is only
 * usually right is the bound that pushes the composer off screen. When not even
 * one line fits we fall back to the trailing characters of the last line, so a
 * clipped region always shows *something* rather than going blank.
 */
function clipTailToRows(content: string, width: number, maxRows: number, measure: Measure): string {
  if (content === "" || maxRows <= 0) return "";
  if (measure(content, width) <= maxRows) return content;

  const lines = content.split("\n");
  const tail = (n: number): string => lines.slice(lines.length - n).join("\n");
  let lo = 0;
  let hi = lines.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(tail(mid), width) <= maxRows) lo = mid;
    else hi = mid - 1;
  }
  while (lo > 0 && measure(tail(lo), width) > maxRows) lo--;
  if (lo > 0) return tail(lo);

  const last = lines[lines.length - 1] ?? "";
  return last.slice(Math.max(0, last.length - maxRows * Math.max(1, width)));
}

/**
 * The LEADING slice of a user prompt that fits in `maxRows`. Head-biased on
 * purpose: an over-long prompt echo is nearly always a paste, and its first
 * lines are what identify it — the opposite of an assistant answer, where the
 * newest words are the ones being read.
 */
export function clipPromptToRows(text: string, width: number, maxRows: number): string {
  const body = Math.max(1, width - GUTTER);
  const budget = maxRows - 1; // marginBottom is unclippable
  if (budget <= 0) return "";
  if (wrappedRows(text, body) <= budget) return text;
  const lines = text.split("\n");
  let used = 0;
  let keep = 0;
  for (const line of lines) {
    const cost = Math.max(1, Math.ceil(line.length / body));
    if (used + cost > budget) break;
    used += cost;
    keep++;
  }
  if (keep > 0) return lines.slice(0, keep).join("\n");
  return (lines[0] ?? "").slice(0, budget * body);
}

/**
 * One turn clipped to its trailing `maxRows` rows at `width` columns.
 *
 * Used for the LIVE (streaming) turn only. Finalized turns are committed to Ink
 * `<Static>` — real terminal scrollback — and must never be cut; the in-flight
 * turn is the one that grows without bound underneath the pinned chrome, so it
 * is the one that gets bounded. What survives is ordered by how recent it is:
 * the newest tool/diff lines, then the tail of the answer, and the reasoning
 * (which sits above the answer) goes first.
 */
export function clipTurnToRows(
  turn: Turn,
  width: number,
  maxRows: number,
  streaming = false,
): Turn {
  if (maxRows <= 0) return turn;
  if (estimateTurnRows(turn, width, streaming) <= maxRows) return turn;

  const body = Math.max(1, width - GUTTER);
  // `marginBottom` and the trailing streaming cursor are structural — no amount
  // of clipping removes them, so they come off the budget first.
  const fixed = 1 + (streaming && turn.text ? 1 : 0);
  let left = Math.max(1, maxRows - fixed);

  // Tool lines and diff summaries are one row each and are the turn's most
  // recent activity, so they are kept in preference to older prose — but never
  // all of it: one row always stays for the answer's tail, so a clipped turn
  // can't become a wall of tool lines with the reply nowhere in sight.
  let tools = turn.tools;
  let diffs = turn.diffs;
  if (tools.length + diffs.length >= left) {
    const keep = Math.max(0, left - 1);
    const keptDiffs = Math.min(diffs.length, keep);
    diffs = diffs.slice(diffs.length - keptDiffs);
    tools = tools.slice(tools.length - Math.max(0, keep - keptDiffs));
  }
  left = Math.max(1, left - (tools.length + diffs.length));

  // Reasoning renders above the answer, so it is the first content dropped —
  // unless the turn is still only reasoning, in which case its tail is all
  // there is to show.
  const text = clipTailToRows(turn.text, body, left, estimateMarkdownRows);
  const reasoning = turn.text ? "" : clipTailToRows(turn.reasoning, body, left, wrappedRows);

  return { ...turn, text, reasoning, tools, diffs };
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
