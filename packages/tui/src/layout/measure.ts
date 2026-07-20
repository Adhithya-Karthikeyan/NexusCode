/**
 * Deterministic pane geometry (design spec §2.1, §2.8).
 *
 * The pane tree used to be handed straight to Yoga with `flexGrow`/`flexBasis`
 * and no hard width, which meant a pane's *content* could be wider than the
 * space the split actually had. Ink then drew the frame's top/bottom border at
 * the Yoga width but the body rows at the content width, producing the ragged
 * `││` seams and lines that ran past the right edge of the terminal.
 *
 * So we stop asking Yoga to guess: this module resolves every node to an exact
 * integer {@link Rect} up front. The renderer then hands each pane a literal
 * `width`/`height`, and every text run is wrapped or truncated against that
 * number. The invariant this file exists to hold:
 *
 *   sum(children) + gaps === parent, exactly, at every width — and no pane is
 *   ever narrower than {@link MIN_PANE_WIDTH}.
 *
 * When the budget cannot satisfy that, panes are **dropped whole** (width 0,
 * the renderer skips them) rather than squeezed into unreadable slivers — the
 * §2.6 collapse rule, applied to width. The pane that yields first is the one
 * with the lowest `grow` (rails before the conversation), ties going rightmost.
 *
 * Pure integer arithmetic, no React: fully unit-testable.
 */

import type { PaneNode, Size } from "./tree.js";

/** An exact, integer cell rectangle. */
export interface Rect {
  width: number;
  height: number;
}

/** Node id → the exact rect that node was allotted. */
export type LayoutMap = ReadonlyMap<string, Rect>;

/** One blank column between side-by-side panes (stacked panes need none — their
 * horizontal borders meet cleanly). */
export const PANE_GAP = 1;

/** Below this a bordered pane has ≤8 usable columns and is worse than nothing. */
export const MIN_PANE_WIDTH = 14;

/** Border (2) + horizontal padding (2). */
export const PANE_CHROME_X = 4;

/** Title row + border rows. */
export const PANE_CHROME_Y = 3;

/**
 * Split `total` cells across `specs`, honouring `basis`/`grow`/`min` and
 * reserving `gap` cells between every pair of *kept* children.
 *
 * Returns one span per spec, in order; a `0` span means the child was dropped
 * because the budget could not seat it at its minimum. The returned spans plus
 * the gaps between non-zero entries always sum to exactly `total` (or to `0`
 * when `total` is non-positive).
 */
export function distribute(total: number, specs: readonly Size[], gap = 0): number[] {
  const n = specs.length;
  if (n === 0) return [];
  if (total <= 0) return specs.map(() => 0);

  const floorOf = (s: Size): number => Math.max(1, s.min);
  const kept = specs.map(() => true);
  const keptCount = (): number => kept.reduce((a, k) => a + (k ? 1 : 0), 0);
  const budget = (): number => total - gap * Math.max(0, keptCount() - 1);
  const needed = (): number => specs.reduce((a, s, i) => a + (kept[i] ? floorOf(s) : 0), 0);

  // Drop whole panes until the survivors fit at their minimums. The least
  // growable pane yields first (a `grow:1` rail before a `grow:3` conversation);
  // on a tie the rightmost goes, which is reading-order-last.
  while (keptCount() > 1 && needed() > budget()) {
    let victim = -1;
    let worst = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      if (!kept[i]) continue;
      const g = specs[i]!.grow;
      if (g <= worst) {
        worst = g;
        victim = i;
      }
    }
    if (victim < 0) break;
    kept[victim] = false;
  }

  const live = specs.map((_, i) => i).filter((i) => kept[i]);
  const space = budget();
  const out = specs.map(() => 0);
  if (live.length === 0) return out;
  if (live.length === 1) {
    out[live[0]!] = Math.max(0, space);
    return out;
  }

  // Seed every survivor at its preferred size, then grow or shrink to fit
  // exactly. `basis` is a preference, `min` is a promise.
  for (const i of live) out[i] = Math.max(floorOf(specs[i]!), specs[i]!.basis);
  let used = live.reduce((a, i) => a + out[i]!, 0);

  if (used < space) {
    const extra = space - used;
    const totalGrow = live.reduce((a, i) => a + Math.max(0, specs[i]!.grow), 0);
    if (totalGrow > 0) {
      // Largest-remainder apportionment: integer shares that sum exactly.
      const exact = live.map((i) => (extra * Math.max(0, specs[i]!.grow)) / totalGrow);
      const share = exact.map((v) => Math.floor(v));
      let assigned = share.reduce((a, b) => a + b, 0);
      const byRemainder = exact
        .map((v, k) => ({ k, rem: v - Math.floor(v) }))
        .sort((a, b) => b.rem - a.rem || a.k - b.k);
      let r = 0;
      while (assigned < extra && byRemainder.length > 0) {
        share[byRemainder[r % byRemainder.length]!.k]! += 1;
        assigned += 1;
        r += 1;
      }
      live.forEach((i, k) => {
        out[i]! += share[k]!;
      });
    } else {
      out[live[live.length - 1]!]! += extra;
    }
  } else if (used > space) {
    // Shave from whoever has the most slack above its minimum, one cell at a
    // time, so the squeeze is shared instead of gutting one pane.
    let over = used - space;
    while (over > 0) {
      let victim = -1;
      let slack = 0;
      for (const i of live) {
        const s = out[i]! - floorOf(specs[i]!);
        if (s > slack) {
          slack = s;
          victim = i;
        }
      }
      if (victim < 0) break;
      out[victim]! -= 1;
      over -= 1;
    }
    // Minimums alone still overflow (a very small terminal): take from the
    // widest until it fits, so we clip rather than spill past the edge.
    while (over > 0) {
      let victim = live[0]!;
      for (const i of live) if (out[i]! > out[victim]!) victim = i;
      if (out[victim]! <= 1) break;
      out[victim]! -= 1;
      over -= 1;
    }
  }

  return out;
}

/** The size a node carries when its parent split did not name one. */
function sizeOf(node: PaneNode, fallback: Size | undefined): Size {
  if (fallback) return fallback;
  if (node.kind === "leaf") return node.size;
  return { basis: 0, grow: 1, min: MIN_PANE_WIDTH };
}

/**
 * Resolve every node in `node` to an exact rect inside `rect`.
 *
 * A `split` divides its rect along its axis (rows reserve {@link PANE_GAP}
 * between children); a `stack` hands its whole rect to the active child (they
 * share one frame); a `leaf` simply takes what it is given. Children that were
 * dropped get a zero rect — {@link isVisible} is the renderer's check.
 */
export function layoutTree(
  node: PaneNode,
  rect: Rect,
  out: Map<string, Rect> = new Map(),
): Map<string, Rect> {
  out.set(node.id, rect);

  if (node.kind === "leaf") return out;

  if (node.kind === "stack") {
    const child = node.children[node.active] ?? node.children[0];
    if (child) layoutTree(child, rect, out);
    return out;
  }

  const isRow = node.axis === "row";
  const gap = isRow ? PANE_GAP : 0;
  const total = isRow ? rect.width : rect.height;
  const specs = node.children.map((c, i) => sizeOf(c, node.sizes[i]));
  const spans = distribute(total, specs, gap);

  node.children.forEach((child, i) => {
    const span = spans[i]!;
    layoutTree(
      child,
      isRow ? { width: span, height: rect.height } : { width: rect.width, height: span },
      out,
    );
  });
  return out;
}

/** Whether a measured node has room to render at all. */
export function isVisible(rect: Rect | undefined): boolean {
  return rect !== undefined && rect.width > 0 && rect.height > 0;
}

/** Look a node's rect up, falling back to a safe non-zero box. */
export function rectFor(map: LayoutMap, id: string, fallback: Rect): Rect {
  return map.get(id) ?? fallback;
}

/**
 * Truncate `text` to `max` display columns, marking the cut with an ellipsis.
 * Used everywhere a label must not be allowed to widen its container (pane
 * titles, tab strips, rail summaries).
 */
export function truncate(text: string, max: number, unicode = true): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  const ell = unicode ? "…" : "..";
  if (max <= ell.length) return text.slice(0, max);
  return text.slice(0, max - ell.length) + ell;
}
