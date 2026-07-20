/**
 * `<PlanTree>` / `<TodoList>` — the plan / task views (design spec §2.2 `plan`,
 * §3.4). **Pure renderers** over a task list. Every status is carried by a
 * **glyph + color + text label** (§1.3.2 — color is never load-bearing):
 * `done ✓` · `doing ▸` · `todo ○` · `blocked ▲` · `skipped ⊘` (struck through).
 * A header tallies progress (`3/7 ✓ · 1 blocked`). `<PlanTree>` renders nested
 * subtasks with indentation; `<TodoList>` renders a flat list.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { glyph, type GlyphName } from "../caps/glyphs.js";
import type { TokenId } from "@nexuscode/theme";
import { useTextStyle, type InkTextStyle } from "../theme/ThemeProvider.js";

/** Task lifecycle (§3.4). */
export type TaskStatus = "todo" | "doing" | "done" | "blocked" | "skipped";

/** One plan/todo node. `children` nest only in `<PlanTree>`. */
export interface PlanItem {
  id: string;
  label: string;
  status: TaskStatus;
  children?: readonly PlanItem[];
}

/** Glyph + color token + screen-reader word per status (never color-only). */
const STATUS: Record<TaskStatus, { glyph: GlyphName; token: TokenId; word: string }> = {
  done: { glyph: "ok", token: "success.fg", word: "done" },
  doing: { glyph: "focus", token: "accent.default", word: "doing" },
  todo: { glyph: "dotHollow", token: "text.muted", word: "todo" },
  blocked: { glyph: "blocked", token: "warning.fg", word: "blocked" },
  skipped: { glyph: "skipped", token: "text.muted", word: "skipped" },
};

function walk(items: readonly PlanItem[], fn: (item: PlanItem) => void): void {
  for (const item of items) {
    fn(item);
    if (item.children) walk(item.children, fn);
  }
}

/** Progress tally across all (nested) nodes: `3/7 ✓ · 1 blocked`. */
export function planProgress(items: readonly PlanItem[]): {
  done: number;
  total: number;
  blocked: number;
} {
  let done = 0;
  let total = 0;
  let blocked = 0;
  walk(items, (item) => {
    total++;
    if (item.status === "done") done++;
    else if (item.status === "blocked") blocked++;
  });
  return { done, total, blocked };
}

/** Shared per-status style bundle (hooks resolved once, then indexed). */
function useStatusStyles(): Record<TaskStatus, InkTextStyle> {
  return {
    done: useTextStyle("success.fg"),
    doing: useTextStyle("accent.default"),
    todo: useTextStyle("text.muted"),
    blocked: useTextStyle("warning.fg"),
    skipped: useTextStyle("text.muted"),
  };
}

function TaskRow({
  item,
  depth,
  styles,
}: {
  item: PlanItem;
  depth: number;
  styles: Record<TaskStatus, InkTextStyle>;
}): React.JSX.Element {
  const caps = useCaps();
  const s = STATUS[item.status];
  const base = styles[item.status];
  // Skipped labels are struck through in addition to the glyph (§3.4).
  const style: InkTextStyle = item.status === "skipped" ? { ...base, strikethrough: true } : base;
  const indent = "  ".repeat(depth);
  return (
    <Text {...style}>
      {indent}
      {glyph(caps, s.glyph)} {item.label}
    </Text>
  );
}

function ProgressHeader({ items }: { items: readonly PlanItem[] }): React.JSX.Element {
  const caps = useCaps();
  const muted = useTextStyle("text.muted");
  const { done, total, blocked } = planProgress(items);
  return (
    <Text {...muted}>
      {done}/{total} {glyph(caps, "ok")}
      {blocked > 0 ? ` · ${blocked} blocked` : ""}
    </Text>
  );
}

export interface PlanTreeProps {
  items: readonly PlanItem[];
  /** Show the progress tally header. Default: true. */
  showHeader?: boolean;
  emptyLabel?: string;
}

/** Nested plan view — renders `children` recursively with indentation. */
export function PlanTree({ items, showHeader = true, emptyLabel = "no plan" }: PlanTreeProps): React.JSX.Element {
  const muted = useTextStyle("text.muted");
  const styles = useStatusStyles();

  if (items.length === 0) return <Text {...muted}>· {emptyLabel}</Text>;

  const rows: React.JSX.Element[] = [];
  const emit = (list: readonly PlanItem[], depth: number): void => {
    for (const item of list) {
      rows.push(<TaskRow key={item.id} item={item} depth={depth} styles={styles} />);
      if (item.children && item.children.length > 0) emit(item.children, depth + 1);
    }
  };
  emit(items, 0);

  return (
    <Box flexDirection="column">
      {showHeader ? <ProgressHeader items={items} /> : null}
      {rows}
    </Box>
  );
}

export interface TodoListProps {
  items: readonly PlanItem[];
  showHeader?: boolean;
  emptyLabel?: string;
}

/** Flat task list — ignores nesting (each item on its own line, depth 0). */
export function TodoList({ items, showHeader = true, emptyLabel = "no tasks" }: TodoListProps): React.JSX.Element {
  const muted = useTextStyle("text.muted");
  const styles = useStatusStyles();

  if (items.length === 0) return <Text {...muted}>· {emptyLabel}</Text>;

  return (
    <Box flexDirection="column">
      {showHeader ? <ProgressHeader items={items} /> : null}
      {items.map((item) => (
        <TaskRow key={item.id} item={item} depth={0} styles={styles} />
      ))}
    </Box>
  );
}
