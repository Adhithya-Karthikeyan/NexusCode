/**
 * Conversation content component tests (design spec §3.2, §3.5, §7). Headless via
 * ink-testing-library: render → assert on `lastFrame()`. Every component is a pure
 * renderer over the theme + caps context and (for StreamPane) the `ViewState`.
 */

import { render } from "ink-testing-library";
import { describe, expect, it, afterEach, vi } from "vitest";
// Import from source modules directly (not the barrel) so these tests never
// couple to other components' in-progress files.
import { CapabilityProvider } from "../src/caps/CapabilityProvider.js";
import type { Capabilities } from "../src/caps/capabilities.js";
import { ThemeProvider } from "../src/theme/ThemeProvider.js";
import { reduceEvents } from "../src/store/viewState.js";
import type { UiEvent } from "../src/store/events.js";
import { CodeBlock, tokenizeLine } from "../src/components/CodeBlock.js";
import { Markdown, parseMarkdown, parseInline } from "../src/components/Markdown.js";
import { MessageBubble } from "../src/components/MessageBubble.js";
import { StreamingCursor } from "../src/components/StreamingCursor.js";
import { TypingIndicator } from "../src/components/TypingIndicator.js";
import { StreamPane } from "../src/components/StreamPane.js";
import { motionTier } from "../src/components/motion.js";

/** A capable truecolor/unicode terminal, motion off (no timers) by default. */
const richCaps: Partial<Capabilities> = {
  truecolor: true,
  colors256: true,
  unicode: true,
  noColor: false,
  screenReader: false,
  reducedMotion: true, // reduced → static, so tests never leak intervals
  isTTY: true,
  termDumb: false,
  width: 100,
  height: 40,
};

function wrap(node: React.ReactNode, caps: Partial<Capabilities> = richCaps): React.JSX.Element {
  return (
    <CapabilityProvider caps={caps}>
      <ThemeProvider>{node}</ThemeProvider>
    </CapabilityProvider>
  );
}

// Nexus Noir accent (#22D3EE) as a truecolor SGR — proof a token reached Ink.
const ACCENT_TRUECOLOR = "38;2;34;211;238";

afterEach(() => {
  vi.useRealTimers();
});

describe("motionTier (§7)", () => {
  it("maps caps to full / reduced / none", () => {
    expect(motionTier({ reducedMotion: false, screenReader: false, termDumb: false, isTTY: true })).toBe("full");
    expect(motionTier({ reducedMotion: true, screenReader: false, termDumb: false, isTTY: true })).toBe("reduced");
    expect(motionTier({ reducedMotion: false, screenReader: true, termDumb: false, isTTY: true })).toBe("none");
    expect(motionTier({ reducedMotion: false, screenReader: false, termDumb: true, isTTY: true })).toBe("none");
    expect(motionTier({ reducedMotion: false, screenReader: false, termDumb: false, isTTY: false })).toBe("none");
  });
});

describe("<StreamingCursor> (§3.2, §7)", () => {
  it("renders a static block at the reduced tier (no blink)", () => {
    const { lastFrame } = render(wrap(<StreamingCursor active />));
    expect(lastFrame() ?? "").toContain("▮");
  });

  it("renders nothing when inactive", () => {
    const { lastFrame } = render(wrap(<StreamingCursor active={false} />));
    expect((lastFrame() ?? "").trim()).toBe("");
  });

  it("degrades to ASCII on a non-unicode terminal", () => {
    const { lastFrame } = render(wrap(<StreamingCursor active />, { ...richCaps, unicode: false }));
    expect(lastFrame() ?? "").toContain("|");
    expect(lastFrame() ?? "").not.toContain("▮");
  });

  it("shows the blink caret at the full tier and tears the timer down on unmount", () => {
    vi.useFakeTimers();
    const { lastFrame, unmount } = render(
      wrap(<StreamingCursor active blinkMs={100} />, { ...richCaps, reducedMotion: false }),
    );
    expect(lastFrame() ?? "").toContain("▍"); // full-tier caret (not the static ▮)
    expect(lastFrame() ?? "").not.toContain("▮");
    unmount(); // clearInterval on cleanup — no leaked timer
  });
});

describe("<TypingIndicator> (§7 — never bare)", () => {
  it("always carries a textual label", () => {
    const { lastFrame } = render(wrap(<TypingIndicator label="streaming 142 tok/s" active />));
    expect(lastFrame() ?? "").toContain("streaming 142 tok/s");
  });

  it("is a static ellipsis at the reduced tier", () => {
    const { lastFrame } = render(wrap(<TypingIndicator label="thinking" active />));
    expect(lastFrame() ?? "").toContain("⋯");
    expect(lastFrame() ?? "").toContain("thinking");
  });

  it("renders nothing when inactive", () => {
    const { lastFrame } = render(wrap(<TypingIndicator active={false} />));
    expect((lastFrame() ?? "").trim()).toBe("");
  });
});

describe("tokenizeLine (§4.7 syntax mapping)", () => {
  it("classifies keywords, strings, numbers, comments, functions, types", () => {
    const spans = tokenizeLine('const x = foo(42, "hi") // note');
    const byKind = (k: string): string =>
      spans.filter((s) => s.kind === k).map((s) => s.text).join("");
    expect(byKind("keyword")).toContain("const");
    expect(byKind("function")).toContain("foo");
    expect(byKind("number")).toContain("42");
    expect(byKind("string")).toContain('"hi"');
    expect(byKind("comment")).toContain("// note");
  });

  it("recognizes constants and capitalized types", () => {
    const spans = tokenizeLine("let ok = true; const T: MyType = null");
    const kinds = spans.filter((s) => s.text.trim()).map((s) => `${s.kind}:${s.text}`);
    expect(kinds).toContain("constant:true");
    expect(kinds).toContain("constant:null");
    expect(kinds).toContain("type:MyType");
  });

  it("never drops characters (round-trips the source)", () => {
    const line = 'if (a.b >= 0x1F) { return `${x}`; } # tail';
    expect(tokenizeLine(line).map((s) => s.text).join("")).toBe(line);
  });
});

describe("<CodeBlock> (§3.5)", () => {
  it("syntax-highlights with theme tokens (color reaches Ink)", () => {
    const { lastFrame } = render(wrap(<CodeBlock code={'const x = 1'} showLineNumbers={false} />));
    const frame = lastFrame() ?? "";
    // Highlighting inserts SGR escapes between tokens, so assert per-token.
    expect(frame).toContain("const");
    expect(frame).toContain("x");
    expect(frame).toContain("1");
    expect(frame).toContain("["); // SGR escapes present
  });

  it("renders a line-number gutter", () => {
    const { lastFrame } = render(wrap(<CodeBlock code={"a\nb\nc"} />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("1 │");
    expect(frame).toContain("3 │");
  });

  it("drops color and bolds only keywords under --plain", () => {
    const { lastFrame } = render(
      wrap(<CodeBlock code={"const x = 1"} showLineNumbers={false} />, { ...richCaps, noColor: true }),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("const");
    expect(frame).not.toContain(ACCENT_TRUECOLOR); // no color escapes for syntax
  });

  it("windows tall code and shows more-row markers (scroll)", () => {
    const code = Array.from({ length: 20 }, (_, i) => `line${i}`).join("\n");
    const { lastFrame } = render(
      wrap(<CodeBlock code={code} maxHeight={5} scrollOffset={8} showLineNumbers={false} />),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("more");
    expect(frame).toContain("↑");
    expect(frame).toContain("↓");
  });

  it("soft-wraps long lines to width", () => {
    const { lastFrame } = render(
      wrap(<CodeBlock code={"aaaaaaaaaaaaaaaaaaaa"} width={10} showLineNumbers={false} />),
    );
    const lines = (lastFrame() ?? "").split("\n").filter((l) => l.includes("a"));
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe("Markdown parsing", () => {
  it("splits blocks: heading, list, fenced code, paragraph", () => {
    const blocks = parseMarkdown("# Title\n\n- a\n- b\n\n```ts\nconst x=1\n```\n\nhello");
    const kinds = blocks.map((b) => b.kind);
    expect(kinds).toContain("heading");
    expect(kinds).toContain("list");
    expect(kinds).toContain("code");
    expect(kinds).toContain("paragraph");
  });

  it("parses inline bold / code / link spans", () => {
    const spans = parseInline("a **b** `c` [d](http://x)");
    const kinds = spans.map((s) => s.kind);
    expect(kinds).toContain("bold");
    expect(kinds).toContain("code");
    expect(kinds).toContain("link");
  });
});

describe("<Markdown> (§3.5)", () => {
  it("renders headings, lists, and code blocks", () => {
    const { lastFrame } = render(
      wrap(<Markdown content={"# Hello\n\n- one\n- two\n\n```js\nfoo()\n```"} />),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Hello");
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    expect(frame).toContain("foo"); // fenced code rendered (SGR splits foo/())
  });

  it("renders inline code and links", () => {
    const { lastFrame } = render(wrap(<Markdown content={"use `npm` see [docs](http://x)"} />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("npm");
    expect(frame).toContain("docs");
    expect(frame).toContain("http://x");
  });

  it("renders a table", () => {
    const { lastFrame } = render(wrap(<Markdown content={"| A | B |\n|---|---|\n| 1 | 2 |"} />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("A");
    expect(frame).toContain("B");
    expect(frame).toContain("1");
    expect(frame).toContain("2");
  });

  it("drops the literal `#`/`##` and adds blank-line spacing between blocks (FIX 1 + FIX 2)", () => {
    const content =
      "## Plan\n\nHere is the **approach**:\n\n- read the file\n- patch it\n\n```ts\nfunction add(a, b) {\n  return a + b\n}\n```\n";
    const { lastFrame } = render(wrap(<Markdown content={content} width={60} />));
    const ansi = /\x1b\[[0-9;]*m/g;
    const frame = (lastFrame() ?? "").replace(ansi, "");
    const lines = frame.split("\n");

    // The heading text renders, but with NO leading `#`/`##` anywhere in the frame.
    expect(frame).toContain("Plan");
    expect(frame).not.toMatch(/#{1,6}\s*Plan/);
    expect(frame).not.toContain("#");

    // Blank-line spacing between adjacent blocks: heading → paragraph →
    // list → code each get a blank row above them (Claude-Code breathing room).
    const headingIdx = lines.findIndex((l) => l.includes("Plan"));
    const paraIdx = lines.findIndex((l) => l.includes("approach"));
    const listIdx = lines.findIndex((l) => l.includes("read the file"));
    const codeIdx = lines.findIndex((l) => l.includes("function"));
    expect(headingIdx).toBeGreaterThanOrEqual(0);
    expect(paraIdx).toBeGreaterThan(headingIdx);
    expect(listIdx).toBeGreaterThan(paraIdx);
    expect(codeIdx).toBeGreaterThan(listIdx);
    // A blank (whitespace-only) row separates each pair of blocks.
    expect(lines[headingIdx + 1]?.trim()).toBe("");
    expect(lines.slice(headingIdx + 1, paraIdx).some((l) => l.trim() === "")).toBe(true);
    expect(lines.slice(paraIdx + 1, listIdx).some((l) => l.trim() === "")).toBe(true);
    expect(lines.slice(listIdx + 1, codeIdx).some((l) => l.trim() === "")).toBe(true);

    // Code block stays visually distinct (indented / left-ruled) and highlighted.
    const codeLine = lines[codeIdx] ?? "";
    expect(codeLine.startsWith("function")).toBe(false); // indented, not flush-left
  });
});

describe("<MessageBubble> (§3.2)", () => {
  it("labels the user turn with an accent gutter", () => {
    const { lastFrame } = render(wrap(<MessageBubble role="user">hi there</MessageBubble>));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("you");
    expect(frame).toContain("hi there");
    expect(frame).toContain(ACCENT_TRUECOLOR); // accent gutter reached Ink
  });

  it("hues the assistant turn by provider and carries the letter (§1.3.2)", () => {
    const { lastFrame } = render(
      wrap(
        <MessageBubble role="assistant" provider="anthropic">
          hello
        </MessageBubble>,
      ),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("anthropic");
    expect(frame).toContain("(A)"); // letter attribution, never color-only
    // Anthropic hue #D97757 → truecolor SGR.
    expect(frame).toContain("38;2;217;119;87");
  });

  it("prefixes thinking tone with the ellipsis", () => {
    const { lastFrame } = render(
      wrap(
        <MessageBubble role="assistant" provider="openai" tone="thinking">
          pondering
        </MessageBubble>,
      ),
    );
    expect(lastFrame() ?? "").toContain("⋯ pondering");
  });

  it("appends a streaming cursor when streaming", () => {
    const { lastFrame } = render(
      wrap(
        <MessageBubble role="assistant" provider="openai" streaming>
          writing
        </MessageBubble>,
      ),
    );
    expect(lastFrame() ?? "").toContain("▮"); // static cursor at reduced tier
  });
});

describe("<StreamPane> (§3.2)", () => {
  const baseEvents: UiEvent[] = [
    { t: "session", id: "run1", provider: "anthropic", model: "Opus 4.8", ts: 1 },
  ];

  it("shows the empty state before any turn", () => {
    const view = reduceEvents(baseEvents);
    const { lastFrame } = render(wrap(<StreamPane view={view} />));
    expect(lastFrame() ?? "").toContain("Ready. Ask anything.");
  });

  it("renders the live streaming turn with a cursor", () => {
    const view = reduceEvents([...baseEvents, { t: "text", lane: "main", delta: "Hello world" }]);
    const { lastFrame } = render(wrap(<StreamPane view={view} />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Hello world");
    expect(frame).toContain("anthropic");
    expect(frame).toContain("▮"); // live cursor
  });

  it("renders finalized turns (Mode B inline)", () => {
    const view = reduceEvents([
      ...baseEvents,
      { t: "text", lane: "main", delta: "first answer" },
      { t: "done", lane: "main", finishReason: "stop" },
    ]);
    const { lastFrame } = render(wrap(<StreamPane view={view} mode="viewport" />));
    expect(lastFrame() ?? "").toContain("first answer");
  });

  it("renders reasoning as a thinking bubble", () => {
    const view = reduceEvents([...baseEvents, { t: "reasoning", lane: "main", delta: "let me think" }]);
    const { lastFrame } = render(wrap(<StreamPane view={view} />));
    expect(lastFrame() ?? "").toContain("let me think");
  });

  it("shows an inline error state with retry hint", () => {
    const view = reduceEvents(baseEvents);
    const { lastFrame } = render(
      wrap(<StreamPane view={view} error={{ message: "rate limited", retryable: true }} />),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("rate limited");
    expect(frame).toContain("[r] retry");
  });

  it("shows the autoscroll cue when paused with new messages", () => {
    const view = reduceEvents([...baseEvents, { t: "text", lane: "main", delta: "x" }]);
    const { lastFrame } = render(wrap(<StreamPane view={view} newCount={3} />));
    expect(lastFrame() ?? "").toContain("3 new");
  });

  it("mounts under Mode A with Static flush without crashing", () => {
    const view = reduceEvents([
      ...baseEvents,
      { t: "text", lane: "main", delta: "committed" },
      { t: "done", lane: "main", finishReason: "stop" },
    ]);
    const { lastFrame } = render(wrap(<StreamPane view={view} mode="scrollback" flushFinalized />));
    expect(lastFrame() ?? "").toContain("committed");
  });
});
