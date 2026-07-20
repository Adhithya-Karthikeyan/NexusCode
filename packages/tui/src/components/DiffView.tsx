/**
 * `<DiffView>` — unified-diff renderer (design spec §2.2 `git_diff`, §3.5). A
 * **pure renderer** over a unified-diff patch string (the `patch` of a
 * {@link ../store/viewState.TurnDiff}). Color is **never load-bearing** (§1.3.2,
 * §3.5): additions carry a `+` gutter **and** `diff.added.fg` (which bakes in
 * `underline`), removals carry a `−` gutter **and** `diff.removed.fg` (which
 * bakes in `strikethrough`), so the diff reads correctly on a monochrome or CVD
 * terminal. Line numbers render in `diff.gutter`.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { useTextStyle } from "../theme/ThemeProvider.js";

/** One classified line of a unified diff. */
export interface DiffLine {
  kind: "add" | "del" | "context" | "hunk" | "meta";
  /** Content without the leading +/-/space (raw text for hunk/meta). */
  text: string;
  /** 1-based old-file line (present on `del` and `context`). */
  oldLn?: number;
  /** 1-based new-file line (present on `add` and `context`). */
  newLn?: number;
}

export interface DiffViewProps {
  /** Unified diff text (`@@` hunks, `+`/`-`/context lines). */
  patch: string;
  /** File path shown in the header. */
  path?: string;
  /** Show the header line (`path +A −B`). Default: true. */
  showHeader?: boolean;
  /** Show the action hint footer (`[a]ccept [r]eject …`). Default: false. */
  showActions?: boolean;
  /** Placeholder when the patch is empty / binary. */
  emptyLabel?: string;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff into classified lines, tracking old/new line numbers.
 * `+++`/`---`/`diff`/`index`/`\` lines are file metadata, checked before the
 * bare `+`/`-` content lines so headers are never mistaken for edits.
 */
export function parseUnifiedDiff(patch: string): DiffLine[] {
  const raw = patch.split("\n");
  // Drop a single trailing empty line produced by a terminating newline.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();

  const out: DiffLine[] = [];
  let oldLn = 0;
  let newLn = 0;

  for (const line of raw) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLn = Number(hunk[1]);
      newLn = Number(hunk[2]);
      out.push({ kind: "hunk", text: line });
      continue;
    }
    if (
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("diff ") ||
      line.startsWith("index ") ||
      line.startsWith("\\")
    ) {
      out.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      out.push({ kind: "add", text: line.slice(1), newLn });
      newLn++;
      continue;
    }
    if (line.startsWith("-")) {
      out.push({ kind: "del", text: line.slice(1), oldLn });
      oldLn++;
      continue;
    }
    const text = line.startsWith(" ") ? line.slice(1) : line;
    out.push({ kind: "context", text, oldLn, newLn });
    oldLn++;
    newLn++;
  }

  return out;
}

function countChanges(lines: readonly DiffLine[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const l of lines) {
    if (l.kind === "add") adds++;
    else if (l.kind === "del") dels++;
  }
  return { adds, dels };
}

export function DiffView({
  patch,
  path,
  showHeader = true,
  showActions = false,
  emptyLabel = "no changes",
}: DiffViewProps): React.JSX.Element {
  const caps = useCaps();
  const addStyle = useTextStyle("diff.added.fg");
  const delStyle = useTextStyle("diff.removed.fg");
  const ctxStyle = useTextStyle("diff.context");
  const gutterStyle = useTextStyle("diff.gutter");
  const hunkStyle = useTextStyle("accent.default");
  const metaStyle = useTextStyle("text.muted");
  const titleStyle = useTextStyle("chrome.title");
  const mutedStyle = useTextStyle("text.muted");

  const lines = parseUnifiedDiff(patch);

  if (lines.length === 0) {
    return <Text {...mutedStyle}>· {emptyLabel}</Text>;
  }

  const { adds, dels } = countChanges(lines);
  const minus = caps.unicode ? "−" : "-";

  // Gutter width from the largest line number we will print.
  let maxLn = 0;
  for (const l of lines) maxLn = Math.max(maxLn, l.oldLn ?? 0, l.newLn ?? 0);
  const gw = Math.max(2, String(maxLn).length);
  const pad = (n: number | undefined): string => (n === undefined ? " ".repeat(gw) : String(n).padStart(gw));

  return (
    <Box flexDirection="column">
      {showHeader ? (
        <Text {...titleStyle}>
          {path ?? "diff"}
          <Text {...addStyle}> +{adds}</Text>
          <Text {...delStyle}>
            {" "}
            {minus}
            {dels}
          </Text>
        </Text>
      ) : null}

      {lines.map((l, i) => {
        if (l.kind === "hunk") {
          return (
            <Text key={i} {...hunkStyle}>
              {l.text}
            </Text>
          );
        }
        if (l.kind === "meta") {
          return (
            <Text key={i} {...metaStyle}>
              {l.text}
            </Text>
          );
        }
        if (l.kind === "add") {
          return (
            <Text key={i}>
              <Text {...gutterStyle}>{pad(l.newLn)} </Text>
              <Text {...addStyle}>+ {l.text}</Text>
            </Text>
          );
        }
        if (l.kind === "del") {
          return (
            <Text key={i}>
              <Text {...gutterStyle}>{pad(l.oldLn)} </Text>
              <Text {...delStyle}>
                {minus} {l.text}
              </Text>
            </Text>
          );
        }
        return (
          <Text key={i}>
            <Text {...gutterStyle}>{pad(l.newLn)} </Text>
            <Text {...ctxStyle}> {l.text}</Text>
          </Text>
        );
      })}

      {showActions ? (
        <Text {...mutedStyle}>[a]ccept [r]eject [Tab] next [A] all</Text>
      ) : null}
    </Box>
  );
}
