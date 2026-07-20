/**
 * `<CommandPalette>` (design spec §2.10, §6.5) — the discoverability spine
 * (`Ctrl+P`). A centered, focus-trapped overlay that fuzzy-filters an **injected**
 * flat `PaletteAction[]` registry (the same actions the CLI/keymap expose — no
 * orphan features). Subsequence scoring with contiguous-run / word-boundary /
 * acronym / prefix bonuses; matched chars are **bold + underline** (never
 * color-only). `↑↓` move, `Enter` run+close, `Ctrl+Enter` run+keep-open, `Esc`
 * close. The palette owns no engine state — it only reads the registry and emits
 * the chosen action. Scoring/filtering are pure and headless-testable.
 */

import { Box, Text, useInput, useStdin } from "ink";
import { useState } from "react";
import { useCaps } from "../caps/CapabilityProvider.js";
import { useColor, useTextStyle } from "../theme/ThemeProvider.js";
import { Icon } from "./Icon.js";

export interface PaletteAction {
  id: string;
  /** Primary label shown + matched (e.g. `/compare`). */
  title: string;
  /** Secondary description in the right/inline column. */
  subtitle?: string;
  /** Group label (e.g. `layout`, `theme`) shown dim on the right. */
  group?: string;
  /** Bound chord shown to teach keybindings (`⌃P`). */
  keybinding?: string;
  /** Extra search terms folded into scoring. */
  keywords?: string[];
  /** Invoked when the action is chosen. */
  run?: () => void;
}

export interface FuzzyMatch {
  action: PaletteAction;
  score: number;
  /** Matched character indices in `action.title` for highlighting. */
  positions: number[];
}

const SEP = new Set([" ", "-", "_", ".", "/", ":"]);

/**
 * Subsequence fuzzy score of `query` against `target` (case-insensitive). Returns
 * `null` when `query` is not a subsequence. Bonuses reward contiguous runs, matches
 * at word boundaries (after a separator / camelCase hump), and a prefix match; a
 * small penalty applies to leading unmatched chars. Higher is better.
 */
export function fuzzyScore(
  query: string,
  target: string,
): { score: number; positions: number[] } | null {
  if (query === "") return { score: 0, positions: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const positions: number[] = [];
  let qi = 0;
  let score = 0;
  let prevMatch = -2;
  let firstMatch = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] !== q[qi]) continue;
    if (firstMatch === -1) firstMatch = ti;
    let bonus = 1;
    if (ti === prevMatch + 1) bonus += 3; // contiguous run
    const prev = ti > 0 ? target[ti - 1] : undefined;
    const isBoundary =
      ti === 0 ||
      (prev !== undefined && SEP.has(prev)) ||
      (prev !== undefined &&
        prev === prev.toLowerCase() &&
        target[ti] !== target[ti]!.toLowerCase()); // camelCase hump
    if (isBoundary) bonus += 2;
    score += bonus;
    positions.push(ti);
    prevMatch = ti;
    qi++;
  }

  if (qi < q.length) return null;
  if (firstMatch === 0) score += 2; // prefix
  score -= Math.min(firstMatch < 0 ? 0 : firstMatch, 3); // leading-gap penalty
  return { score, positions };
}

/**
 * Filter + rank the registry against `query`. Empty query keeps registry order
 * (recents/catalog). Scores `title` first; folds `subtitle`/`keywords` at a
 * discount so a description hit still surfaces the action (positions stay on the
 * title). Ties break by shorter title then original order.
 */
export function filterActions(
  actions: readonly PaletteAction[],
  query: string,
): FuzzyMatch[] {
  if (query.trim() === "") {
    return actions.map((action) => ({ action, score: 0, positions: [] }));
  }
  const out: (FuzzyMatch & { index: number })[] = [];
  actions.forEach((action, index) => {
    const onTitle = fuzzyScore(query, action.title);
    let best = onTitle ? { score: onTitle.score, positions: onTitle.positions } : null;
    const aux = [action.subtitle ?? "", ...(action.keywords ?? [])].filter(Boolean);
    for (const term of aux) {
      const m = fuzzyScore(query, term);
      if (m && (!best || m.score * 0.5 > best.score)) {
        best = { score: m.score * 0.5, positions: onTitle ? onTitle.positions : [] };
      }
    }
    if (best) out.push({ action, score: best.score, positions: best.positions, index });
  });
  out.sort(
    (a, b) =>
      b.score - a.score ||
      a.action.title.length - b.action.title.length ||
      a.index - b.index,
  );
  return out.map(({ action, score, positions }) => ({ action, score, positions }));
}

/** Render a title with matched positions bold+underlined (no color reliance). */
function HighlightedTitle({
  title,
  positions,
  base,
  hit,
}: {
  title: string;
  positions: number[];
  base: ReturnType<typeof useTextStyle>;
  hit: ReturnType<typeof useTextStyle>;
}): React.JSX.Element {
  const set = new Set(positions);
  return (
    <Text>
      {[...title].map((ch, i) =>
        set.has(i) ? (
          <Text key={i} {...hit} bold underline>
            {ch}
          </Text>
        ) : (
          <Text key={i} {...base}>
            {ch}
          </Text>
        ),
      )}
    </Text>
  );
}

export interface CommandPaletteProps {
  actions: readonly PaletteAction[];
  /** Capture keys (default true). Gated on raw-mode support (headless-safe). */
  isActive?: boolean;
  /** Seed query (also the controlled value used by render tests). */
  initialQuery?: string;
  /** Close request (Esc, or Enter after a run). */
  onClose?: () => void;
  /** Fired with the chosen action (in addition to `action.run`). */
  onRun?: (action: PaletteAction) => void;
  /** Max rows shown at once (windowed around the selection). Default 8. */
  maxVisible?: number;
  title?: string;
  measure?: (s: string) => number;
}

export function CommandPalette({
  actions,
  isActive = true,
  initialQuery = "",
  onClose,
  onRun,
  maxVisible = 8,
  title = "Command Palette",
  measure,
}: CommandPaletteProps): React.JSX.Element {
  const caps = useCaps();
  const { isRawModeSupported } = useStdin();
  const [query, setQuery] = useState(initialQuery);
  const [selected, setSelected] = useState(0);

  const results = filterActions(actions, query);
  const sel = results.length === 0 ? 0 : Math.min(selected, results.length - 1);

  const accent = useTextStyle("accent.default");
  const titleStyle = useTextStyle("chrome.title");
  const text = useTextStyle("text.primary");
  const muted = useTextStyle("text.muted");
  const focusRing = useTextStyle("focus.ring");
  const borderColor = useColor("chrome.borderFocus");

  const choose = (keepOpen: boolean): void => {
    const match = results[sel];
    if (!match) return;
    match.action.run?.();
    onRun?.(match.action);
    if (!keepOpen) onClose?.();
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        onClose?.();
        return;
      }
      if (key.return) {
        choose(key.ctrl === true);
        return;
      }
      if (key.upArrow) {
        setSelected((s) => Math.max(0, Math.min(s, results.length - 1) - 1));
        return;
      }
      if (key.downArrow || (key.tab && key.shift !== true)) {
        setSelected((s) => Math.min(results.length - 1, s + 1));
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((qq) => qq.slice(0, -1));
        setSelected(0);
        return;
      }
      if (key.ctrl && input === "u") {
        setQuery("");
        setSelected(0);
        return;
      }
      if (key.ctrl || key.meta) return;
      if (input && input >= " ") {
        setQuery((qq) => qq + input);
        setSelected(0);
      }
    },
    // `=== true`: Ink treats an `undefined` `isActive` (real non-TTY) as active
    // and would throw enabling raw mode; the strict compare keeps it inert.
    { isActive: isActive && isRawModeSupported === true },
  );

  // Window the visible rows around the selection.
  const start = Math.max(0, Math.min(sel - Math.floor(maxVisible / 2), Math.max(0, results.length - maxVisible)));
  const visible = results.slice(start, start + maxVisible);
  const hintSep = caps.unicode ? " · " : " - ";
  const hints = [
    `${caps.unicode ? "↑↓" : "up/dn"} move`,
    "Enter run",
    `${caps.unicode ? "⌃⏎" : "Ctrl+Enter"} keep open`,
    "Esc close",
  ].join(hintSep);

  return (
    <Box
      flexDirection="column"
      borderStyle={caps.unicode ? "round" : "classic"}
      {...(borderColor ? { borderColor } : {})}
      paddingX={1}
      width={72}
    >
      <Box>
        <Icon name="node" style={accent} {...(measure ? { measure } : {})} />
        <Text {...titleStyle}> {title}</Text>
      </Box>
      <Box>
        <Icon name="search" style={muted} {...(measure ? { measure } : {})} />
        <Text {...accent}> {query}</Text>
        <Text {...text}>{caps.unicode ? "▍" : "|"}</Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text {...muted}>
            {results.length} hit{results.length === 1 ? "" : "s"}
          </Text>
        </Box>
      </Box>
      {visible.length === 0 ? (
        <Text {...muted}>· no matches</Text>
      ) : (
        visible.map((match, i) => {
          const index = start + i;
          const isSel = index === sel;
          return (
            <Box key={match.action.id}>
              <Text {...(isSel ? focusRing : muted)}>
                {isSel ? <Icon name="focus" style={focusRing} {...(measure ? { measure } : {})} /> : " "}{" "}
              </Text>
              <HighlightedTitle
                title={match.action.title}
                positions={match.positions}
                base={isSel ? text : muted}
                hit={accent}
              />
              {match.action.subtitle !== undefined ? (
                <Text {...muted}> {match.action.subtitle}</Text>
              ) : null}
              <Box flexGrow={1} justifyContent="flex-end">
                {match.action.group !== undefined ? <Text {...muted}>{match.action.group} </Text> : null}
                {match.action.keybinding !== undefined ? (
                  <Text {...accent}>{match.action.keybinding}</Text>
                ) : null}
              </Box>
            </Box>
          );
        })
      )}
      <Text {...muted}>{hints}</Text>
    </Box>
  );
}
