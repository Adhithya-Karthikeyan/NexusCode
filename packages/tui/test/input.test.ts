import { describe, expect, it } from "vitest";
import {
  buffer as B,
  classifyEsc,
  classifyCtrlC,
  classifyInput,
  createHistory,
  ESC_ESC_WINDOW_MS,
  initialPasteState,
  looksLikePaste,
  newer,
  older,
  pushHistory,
} from "../src/index.js";

describe("input buffer", () => {
  it("inserts, splits, and flattens", () => {
    let b = B.emptyBuffer;
    b = B.insert(b, "hello");
    expect(B.toText(b)).toBe("hello");
    b = B.newline(b);
    b = B.insert(b, "world");
    expect(B.toText(b)).toBe("hello\nworld");
    expect(B.isSingleLine(b)).toBe(false);
  });

  it("backspace joins lines at column 0", () => {
    let b = B.fromText("ab\ncd");
    b = { ...b, row: 1, col: 0 };
    b = B.backspace(b);
    expect(B.toText(b)).toBe("abcd");
    expect(b.row).toBe(0);
    expect(b.col).toBe(2);
  });

  it("readline kills and word-delete", () => {
    let b = B.fromText("foo bar baz");
    b = B.deleteWordLeft(b);
    expect(B.toText(b)).toBe("foo bar ");
    b = B.killToLineStart(b);
    expect(B.toText(b)).toBe("");
  });

  it("detects an open code fence to disable single-Enter submit", () => {
    expect(B.hasOpenFence(B.fromText("```ts\ncode"))).toBe(true);
    expect(B.hasOpenFence(B.fromText("```ts\ncode\n```"))).toBe(false);
  });

  it("insertMultiline places the cursor after a paste", () => {
    const b = B.insertMultiline(B.emptyBuffer, "line1\nline2\nline3");
    expect(B.toText(b)).toBe("line1\nline2\nline3");
    expect(b.row).toBe(2);
    expect(b.col).toBe(5);
  });
});

describe("bracketed-paste guard (law #1)", () => {
  it("classifies multi-line and multi-char chunks as paste", () => {
    expect(looksLikePaste("a\nb")).toBe(true);
    expect(looksLikePaste("hello")).toBe(true);
    expect(looksLikePaste("x")).toBe(false);
  });

  it("treats a burst of chunks as one paste", () => {
    const v1 = classifyInput(initialPasteState, "ab", 1000);
    expect(v1.isPaste).toBe(true);
    const v2 = classifyInput(v1.next, "c", 1010); // <30ms later, single char
    expect(v2.isPaste).toBe(true);
    const v3 = classifyInput(v2.next, "d", 2000); // long gap, single char
    expect(v3.isPaste).toBe(false);
  });
});

describe("history ring", () => {
  it("walks older/newer and preserves the draft", () => {
    let h = createHistory();
    h = pushHistory(h, "first");
    h = pushHistory(h, "second");
    const up1 = older(h, "draft");
    expect(up1?.value).toBe("second");
    const up2 = older(up1!.history, "draft");
    expect(up2?.value).toBe("first");
    const down = newer(up2!.history);
    expect(down?.value).toBe("second");
    const backToDraft = newer(down!.history);
    expect(backToDraft?.value).toBe("draft");
  });

  it("dedupes consecutive repeats", () => {
    let h = createHistory();
    h = pushHistory(h, "x");
    h = pushHistory(h, "x");
    expect(h.entries).toEqual(["x"]);
  });
});

describe("interrupt ladder (§6.6)", () => {
  it("first Esc is graceful, a fast second is a hard stop", () => {
    const first = classifyEsc(0, 1000);
    expect(first.mode).toBe("graceful");
    const second = classifyEsc(first.nextEscTs, 1000 + ESC_ESC_WINDOW_MS - 1);
    expect(second.mode).toBe("hard");
    expect(second.nextEscTs).toBe(0);
  });

  it("a slow second Esc stays graceful", () => {
    const first = classifyEsc(0, 1000);
    const second = classifyEsc(first.nextEscTs, 1000 + ESC_ESC_WINDOW_MS + 100);
    expect(second.mode).toBe("graceful");
  });

  it("Ctrl+C escalates to quit-confirm on a fast repeat", () => {
    const first = classifyCtrlC(0, 1000);
    expect(first.mode).toBe("interrupt");
    const second = classifyCtrlC(first.nextTs, 1500);
    expect(second.mode).toBe("quit-confirm");
  });
});
