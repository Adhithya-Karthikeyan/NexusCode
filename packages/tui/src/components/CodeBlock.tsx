/**
 * `<CodeBlock>` — fenced-code renderer with ANSI syntax highlight (design spec
 * §3.5, §4.7). A **lightweight, language-agnostic tokenizer** maps each line to
 * the 12 `syntax.*` theme tokens; color flows only through tokens (never raw hex,
 * §1.3.1). Redundancy survives no-color: `--plain` (`caps.noColor`) drops all
 * color and renders **bold keywords only** (§3.5), and `syntax.invalid` always
 * carries bold (§4.7) so errors survive monochrome.
 *
 * Wrap + scroll (§3.5, §3.1): long lines soft-wrap to `width`; when the wrapped
 * height exceeds `maxHeight`, a `scrollOffset` window is shown with `↑ N` / `↓ N`
 * more-rows markers so no code is silently clipped.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import type { TokenId } from "@nexuscode/theme";
import { useTextStyle, type InkTextStyle } from "../theme/ThemeProvider.js";

/** Syntax classes produced by the tokenizer (the 12 scopes + `plain`). */
export type SyntaxKind =
  | "keyword"
  | "function"
  | "type"
  | "string"
  | "number"
  | "comment"
  | "operator"
  | "variable"
  | "constant"
  | "tag"
  | "attribute"
  | "invalid"
  | "plain";

/** A contiguous run of one syntax class. */
export interface Span {
  text: string;
  kind: SyntaxKind;
}

/** Language-agnostic keyword set (superset across common languages). */
const KEYWORDS = new Set<string>([
  "const", "let", "var", "function", "func", "fn", "def", "lambda", "return", "yield",
  "if", "else", "elif", "for", "while", "do", "switch", "case", "break", "continue",
  "class", "struct", "interface", "enum", "type", "impl", "trait", "namespace", "module",
  "extends", "implements", "new", "this", "self", "super", "import", "export", "from",
  "as", "default", "async", "await", "try", "catch", "finally", "throw", "raise",
  "typeof", "instanceof", "in", "of", "void", "delete", "public", "private", "protected",
  "static", "readonly", "abstract", "pub", "mut", "use", "mod", "match", "package",
  "go", "defer", "select", "range", "with", "pass", "and", "or", "not", "then", "begin",
  "end", "when", "unless", "until", "let", "where", "declare", "override",
]);

/** Literal constants (§4.7 Constant). */
const CONSTANTS = new Set<string>([
  "true", "false", "null", "nil", "undefined", "None", "True", "False", "NaN", "Infinity",
]);

const IDENT_START = /[A-Za-z_$]/;
const IDENT_PART = /[A-Za-z0-9_$]/;
const DIGIT = /[0-9]/;
const OPERATOR = /[+\-*/%=<>!&|^~?:.,;(){}\[\]@]/;

/** Map a syntax class to a theme token id (`plain` → secondary text). */
function kindToken(kind: SyntaxKind): TokenId {
  if (kind === "plain") return "text.secondary";
  return `syntax.${kind}` as TokenId;
}

/**
 * Tokenize one source line into typed spans. Line-based (no cross-line block
 * comment state) — "lightweight" by design (§3.5). Recognizes line comments
 * (`//`, `#`, `--`), strings (`"` `'` `` ` ``), numbers (incl. `0x`), keywords,
 * constants, function calls (`ident(`), types (Capitalized), and operators.
 */
export function tokenizeLine(line: string): Span[] {
  const spans: Span[] = [];
  let i = 0;
  const n = line.length;
  const push = (text: string, kind: SyntaxKind): void => {
    if (text.length === 0) return;
    const last = spans[spans.length - 1];
    if (last && last.kind === kind) last.text += text;
    else spans.push({ text, kind });
  };

  while (i < n) {
    const c = line[i]!;

    // Whitespace.
    if (c === " " || c === "\t") {
      let j = i;
      while (j < n && (line[j] === " " || line[j] === "\t")) j++;
      push(line.slice(i, j), "plain");
      i = j;
      continue;
    }

    // Line comments: // ... , # ... , -- ...
    if (
      (c === "/" && line[i + 1] === "/") ||
      c === "#" ||
      (c === "-" && line[i + 1] === "-")
    ) {
      push(line.slice(i), "comment");
      break;
    }

    // Strings.
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === c) {
          j++;
          break;
        }
        j++;
      }
      push(line.slice(i, j), "string");
      i = j;
      continue;
    }

    // Numbers (decimal, hex, float).
    if (DIGIT.test(c) || (c === "." && DIGIT.test(line[i + 1] ?? ""))) {
      let j = i;
      if (c === "0" && (line[j + 1] === "x" || line[j + 1] === "X")) {
        j += 2;
        while (j < n && /[0-9a-fA-F]/.test(line[j]!)) j++;
      } else {
        while (j < n && (DIGIT.test(line[j]!) || line[j] === "." || line[j] === "_")) j++;
      }
      push(line.slice(i, j), "number");
      i = j;
      continue;
    }

    // Identifiers / keywords / constants / functions / types.
    if (IDENT_START.test(c)) {
      let j = i;
      while (j < n && IDENT_PART.test(line[j]!)) j++;
      const word = line.slice(i, j);
      // Skip trailing spaces to find the next significant char.
      let k = j;
      while (k < n && (line[k] === " " || line[k] === "\t")) k++;
      let kind: SyntaxKind;
      if (KEYWORDS.has(word)) kind = "keyword";
      else if (CONSTANTS.has(word)) kind = "constant";
      else if (line[k] === "(") kind = "function";
      else if (/^[A-Z]/.test(word)) kind = "type";
      else kind = "variable";
      push(word, kind);
      i = j;
      continue;
    }

    // Operators & punctuation.
    if (OPERATOR.test(c)) {
      push(c, "operator");
      i++;
      continue;
    }

    // Anything else: plain.
    push(c, "plain");
    i++;
  }

  return spans.length > 0 ? spans : [{ text: "", kind: "plain" }];
}

/** One visible row: the 1-based source line number (null on wrap continuations). */
interface Row {
  lineNo: number | null;
  spans: Span[];
}

/** Soft-wrap typed spans to `width`, preserving span boundaries. */
function wrapSpans(spans: Span[], width: number): Span[][] {
  if (width <= 0) return [spans];
  const rows: Span[][] = [];
  let current: Span[] = [];
  let used = 0;
  for (const span of spans) {
    let text = span.text;
    while (text.length > 0) {
      const room = width - used;
      if (room <= 0) {
        rows.push(current);
        current = [];
        used = 0;
        continue;
      }
      const take = text.slice(0, room);
      current.push({ text: take, kind: span.kind });
      used += take.length;
      text = text.slice(room);
    }
  }
  rows.push(current);
  return rows;
}

export interface CodeBlockProps {
  /** The raw source. */
  code: string;
  /** Optional language hint (shown in the header when `showHeader`). */
  lang?: string | undefined;
  /** Wrap width in columns (default: no wrap). */
  width?: number | undefined;
  /** Max visible rows before the scroll window kicks in (default: all). */
  maxHeight?: number | undefined;
  /** First visible wrapped-row index (scroll position). */
  scrollOffset?: number;
  /** Render the `1 │` gutter (default true). */
  showLineNumbers?: boolean;
  /** Render a `lang` header line above the code (default false). */
  showHeader?: boolean;
}

/** A syntax-highlighted, wrappable, scroll-windowed code block. */
export function CodeBlock({
  code,
  lang,
  width,
  maxHeight,
  scrollOffset = 0,
  showLineNumbers = true,
  showHeader = false,
}: CodeBlockProps): React.JSX.Element {
  const caps = useCaps();
  const plain = caps.noColor;
  const gutterStyle = useTextStyle("diff.gutter");
  const headerStyle = useTextStyle("text.muted");
  const moreStyle = useTextStyle("text.muted");

  // Resolve every syntax token once (hooks must be unconditional).
  const styles: Record<SyntaxKind, InkTextStyle> = {
    keyword: useTextStyle("syntax.keyword"),
    function: useTextStyle("syntax.function"),
    type: useTextStyle("syntax.type"),
    string: useTextStyle("syntax.string"),
    number: useTextStyle("syntax.number"),
    comment: useTextStyle("syntax.comment"),
    operator: useTextStyle("syntax.operator"),
    variable: useTextStyle("syntax.variable"),
    constant: useTextStyle("syntax.constant"),
    tag: useTextStyle("syntax.tag"),
    attribute: useTextStyle("syntax.attribute"),
    invalid: useTextStyle("syntax.invalid"),
    plain: useTextStyle("text.secondary"),
  };

  const srcLines = code.replace(/\n$/, "").split("\n");
  const gutterWidth = String(srcLines.length).length;
  const codeWidth = width !== undefined ? Math.max(1, width - (showLineNumbers ? gutterWidth + 3 : 0)) : undefined;

  // Build the flat list of visible rows (wrapping applied).
  const rows: Row[] = [];
  srcLines.forEach((line, idx) => {
    const spans = tokenizeLine(line);
    const wrapped = codeWidth !== undefined ? wrapSpans(spans, codeWidth) : [spans];
    wrapped.forEach((rowSpans, w) => {
      rows.push({ lineNo: w === 0 ? idx + 1 : null, spans: rowSpans });
    });
  });

  // Scroll window.
  const total = rows.length;
  const height = maxHeight ?? total;
  const start = Math.max(0, Math.min(scrollOffset, Math.max(0, total - height)));
  const end = Math.min(total, start + height);
  const visible = rows.slice(start, end);
  const above = start;
  const below = total - end;

  /** Render one span honoring `--plain` (bold keywords only, no color). */
  const renderSpan = (span: Span, key: number): React.JSX.Element => {
    void kindToken; // token id available to callers; Ink consumes the resolved style
    if (plain) {
      // No color: keywords + invalid bold, everything else attribute-plain.
      const bold = span.kind === "keyword" || span.kind === "invalid";
      return (
        <Text key={key} bold={bold}>
          {span.text}
        </Text>
      );
    }
    return (
      <Text key={key} {...styles[span.kind]}>
        {span.text}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      {showHeader ? <Text {...headerStyle}>{lang ? `‹${lang}›` : "‹code›"}</Text> : null}
      {above > 0 ? <Text {...moreStyle}>{caps.unicode ? "↑" : "^"} {above} more</Text> : null}
      {visible.map((row, ri) => (
        <Text key={ri}>
          {showLineNumbers ? (
            <Text {...gutterStyle}>
              {(row.lineNo !== null ? String(row.lineNo) : "").padStart(gutterWidth)} {caps.unicode ? "│" : "|"}{" "}
            </Text>
          ) : null}
          {row.spans.map((span, si) => renderSpan(span, si))}
        </Text>
      ))}
      {below > 0 ? <Text {...moreStyle}>{caps.unicode ? "↓" : "v"} {below} more</Text> : null}
    </Box>
  );
}
