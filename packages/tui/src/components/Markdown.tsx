/**
 * `<Markdown>` — a lightweight terminal Markdown renderer (design spec §3.5).
 * Handles the block set that shows up in assistant output: headings (accent),
 * bullet/ordered lists, fenced code (→ `<CodeBlock>` with syntax highlight),
 * blockquotes, horizontal rules, simple tables, and paragraphs. Inline: bold
 * `**`, italic `*`/`_`, inline code (`surface.inset` background), and links
 * (`text.link` + underline). Color flows only through tokens (§1.3.1).
 *
 * Pure and deterministic: same string → same frame, no engine coupling. It is a
 * parser + renderer, not a state holder.
 */

import { Box, Text } from "ink";
import { useCaps } from "../caps/CapabilityProvider.js";
import { useColor, useTextStyle, type InkTextStyle } from "../theme/ThemeProvider.js";
import { CodeBlock } from "./CodeBlock.js";
import type { ReactNode } from "react";

// ── Block model ────────────────────────────────────────────────────────────

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang?: string; code: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; text: string }
  | { kind: "rule" }
  | { kind: "table"; header: string[]; rows: string[][] };

/** Split GitHub-flavored-ish Markdown into a flat block list (fences respected). */
export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const isTableSep = (s: string): boolean => /^\s*\|?[\s:|-]+\|?\s*$/.test(s) && s.includes("-");
  const splitRow = (s: string): string[] =>
    s.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i]!;

    // Fenced code block.
    const fence = line.match(/^\s*```(.*)$/);
    if (fence) {
      const lang = fence[1]!.trim() || undefined;
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // consume closing fence (if present)
      const code = body.join("\n");
      blocks.push(lang !== undefined ? { kind: "code", lang, code } : { kind: "code", code });
      continue;
    }

    // Blank line.
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]!.trim() });
      i++;
      continue;
    }

    // Table (header row followed by a separator row).
    if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1]!)) {
      const header = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) {
        body.push(lines[i]!.replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }

    // List (unordered or ordered) — consecutive item lines.
    const bullet = line.match(/^\s*([-*+])\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (i < lines.length) {
        const b = lines[i]!.match(/^\s*([-*+])\s+(.*)$/);
        const o = lines[i]!.match(/^\s*\d+[.)]\s+(.*)$/);
        if (isOrdered && o) items.push(o[1]!);
        else if (!isOrdered && b) items.push(b[2]!);
        else break;
        i++;
      }
      blocks.push({ kind: "list", ordered: isOrdered, items });
      continue;
    }

    // Paragraph — gather until a blank line or a block starter.
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^\s*```/.test(lines[i]!) &&
      !/^(#{1,6})\s+/.test(lines[i]!) &&
      !/^\s*>\s?/.test(lines[i]!) &&
      !/^\s*([-*+])\s+/.test(lines[i]!) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]!)
    ) {
      body.push(lines[i]!);
      i++;
    }
    blocks.push({ kind: "paragraph", text: body.join(" ") });
  }

  return blocks;
}

// ── Inline model ───────────────────────────────────────────────────────────

type InlineKind = "text" | "bold" | "italic" | "code" | "link";
interface InlineSpan {
  kind: InlineKind;
  text: string;
  href?: string;
}

/** Parse inline emphasis / code / links into typed spans (single pass). */
export function parseInline(src: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let i = 0;
  const n = src.length;
  let buf = "";
  const flush = (): void => {
    if (buf) spans.push({ kind: "text", text: buf });
    buf = "";
  };
  const findClose = (from: number, marker: string): number => src.indexOf(marker, from);

  while (i < n) {
    const c = src[i]!;
    // Inline code (highest precedence).
    if (c === "`") {
      const close = findClose(i + 1, "`");
      if (close !== -1) {
        flush();
        spans.push({ kind: "code", text: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    // Bold `**` / `__`.
    if ((c === "*" && src[i + 1] === "*") || (c === "_" && src[i + 1] === "_")) {
      const marker = src.slice(i, i + 2);
      const close = src.indexOf(marker, i + 2);
      if (close !== -1) {
        flush();
        spans.push({ kind: "bold", text: src.slice(i + 2, close) });
        i = close + 2;
        continue;
      }
    }
    // Italic `*` / `_`.
    if (c === "*" || c === "_") {
      const close = src.indexOf(c, i + 1);
      if (close !== -1 && close > i + 1) {
        flush();
        spans.push({ kind: "italic", text: src.slice(i + 1, close) });
        i = close + 1;
        continue;
      }
    }
    // Link `[text](href)`.
    if (c === "[") {
      const closeText = src.indexOf("]", i + 1);
      if (closeText !== -1 && src[closeText + 1] === "(") {
        const closeHref = src.indexOf(")", closeText + 2);
        if (closeHref !== -1) {
          flush();
          spans.push({
            kind: "link",
            text: src.slice(i + 1, closeText),
            href: src.slice(closeText + 2, closeHref),
          });
          i = closeHref + 1;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  flush();
  return spans;
}

// ── Rendering ────────────────────────────────────────────────────────────────

function Inline({ text }: { text: string }): React.JSX.Element {
  const base = useTextStyle("stream.text");
  const boldStyle = useTextStyle("text.primary");
  const codeStyle = useTextStyle("text.primary");
  const linkStyle = useTextStyle("text.link");
  const insetBg = useColor("surface.inset");
  const spans = parseInline(text);
  return (
    <Text {...base}>
      {spans.map((s, idx) => {
        switch (s.kind) {
          case "bold":
            return (
              <Text key={idx} {...boldStyle} bold>
                {s.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={idx} {...base} italic>
                {s.text}
              </Text>
            );
          case "code": {
            const style: InkTextStyle & { backgroundColor?: string } = { ...codeStyle };
            if (insetBg) style.backgroundColor = insetBg;
            return (
              <Text key={idx} {...style}>
                {s.text}
              </Text>
            );
          }
          case "link":
            return (
              <Text key={idx} {...linkStyle} underline>
                {s.text}
                {s.href ? ` (${s.href})` : ""}
              </Text>
            );
          default:
            return <Text key={idx}>{s.text}</Text>;
        }
      })}
    </Text>
  );
}

export interface MarkdownProps {
  /** The Markdown source to render. */
  content: string;
  /** Wrap width (columns) passed to fenced `<CodeBlock>`s. */
  width?: number | undefined;
}

/** Render Markdown as themed Ink nodes. */
export function Markdown({ content, width }: MarkdownProps): React.JSX.Element {
  const caps = useCaps();
  const heading = useTextStyle("accent.default");
  const muted = useTextStyle("text.muted");
  const quoteStyle = useTextStyle("text.secondary");
  const ruleStyle = useTextStyle("chrome.divider");
  const codeRuleColor = useColor("chrome.divider");
  const bullet = caps.unicode ? "•" : "-";
  const quoteBar = caps.unicode ? "▏" : ">";
  const blocks = parseMarkdown(content);

  // Every block after the first gets a blank line above it (§3.5 breathing
  // room, Claude-Code style) — headings, paragraphs, lists, code, quotes and
  // rules all share one spacing rule so the body never reads cramped.
  const renderBlock = (b: Block, key: number): ReactNode => {
    const marginTop = key === 0 ? 0 : 1;
    switch (b.kind) {
      case "heading":
        // No literal `#` — the heading reads as bold + accent text, the way
        // Claude Code shows headings (level is still parsed, just not printed).
        return (
          <Box key={key} marginTop={marginTop}>
            <Text {...heading} bold>
              {b.text}
            </Text>
          </Box>
        );
      case "paragraph":
        return (
          <Box key={key} marginTop={marginTop}>
            <Inline text={b.text} />
          </Box>
        );
      case "code": {
        // Left rule + indent (border consumes 1 col, padding 1 col) keeps the
        // block visually distinct from prose; shrink the wrap width by the
        // same 2 cols so highlighted lines don't overflow the container.
        const codeWidth = width !== undefined ? Math.max(1, width - 2) : undefined;
        return (
          <Box
            key={key}
            marginTop={marginTop}
            flexDirection="column"
            paddingLeft={1}
            borderStyle="single"
            borderTop={false}
            borderBottom={false}
            borderRight={false}
            {...(codeRuleColor ? { borderColor: codeRuleColor } : {})}
          >
            <CodeBlock code={b.code} lang={b.lang} width={codeWidth} showLineNumbers={false} />
          </Box>
        );
      }
      case "list":
        return (
          <Box key={key} marginTop={marginTop} flexDirection="column">
            {b.items.map((item, idx) => (
              <Box key={idx}>
                <Text {...muted}>{b.ordered ? `${idx + 1}.` : bullet} </Text>
                <Inline text={item} />
              </Box>
            ))}
          </Box>
        );
      case "quote":
        return (
          <Box key={key} marginTop={marginTop}>
            <Text {...muted}>{quoteBar} </Text>
            <Text {...quoteStyle} italic>
              {b.text}
            </Text>
          </Box>
        );
      case "rule":
        return (
          <Box key={key} marginTop={marginTop}>
            <Text {...ruleStyle}>{(caps.unicode ? "─" : "-").repeat(Math.min(width ?? 24, 24))}</Text>
          </Box>
        );
      case "table": {
        const cols = b.header.length;
        const widths = b.header.map((h, c) =>
          Math.max(h.length, ...b.rows.map((r) => (r[c] ?? "").length)),
        );
        const fmt = (cells: string[]): string =>
          cells.map((cell, c) => (cell ?? "").padEnd(widths[c] ?? 0)).join("  ");
        return (
          <Box key={key} marginTop={marginTop} flexDirection="column">
            <Text {...heading} bold>
              {fmt(b.header)}
            </Text>
            <Text {...muted}>{widths.map((w) => (caps.unicode ? "─" : "-").repeat(w)).join("  ")}</Text>
            {b.rows.map((r, idx) => (
              <Text key={idx} {...quoteStyle}>
                {fmt(Array.from({ length: cols }, (_, c) => r[c] ?? ""))}
              </Text>
            ))}
          </Box>
        );
      }
    }
  };

  return <Box flexDirection="column">{blocks.map((b, idx) => renderBlock(b, idx))}</Box>;
}
