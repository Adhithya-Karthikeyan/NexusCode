/**
 * Regression (W15): the REAL composer must send on Enter. A lone Enter arrives
 * as a single-character "\r"; the bracketed-paste guard used to misclassify it
 * as paste and insert a newline instead of submitting — so Enter never sent.
 * This drives the actual <App> over ink-testing-library stdin to prove the fix.
 */
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App, type Capabilities, type UiEvent } from "../src/index.js";

const richCaps: Partial<Capabilities> = {
  truecolor: true,
  colors256: true,
  unicode: true,
  noColor: false,
  screenReader: false,
  reducedMotion: false,
  isTTY: true,
  termDumb: false,
  width: 120,
  height: 40,
};

const seedEvents: UiEvent[] = [
  { t: "session", id: "run1", provider: "mock", model: "mock-fast", ts: 1 },
];

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 40));

describe("W15 real TUI input", () => {
  it("types 'hello', Enter dispatches a run + clears the draft, no overlap", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <App
        caps={richCaps}
        viewport={{ cols: 120, rows: 40 }}
        initialPreset="chat"
        sessionName="w15"
        events={seedEvents}
        onSubmit={onSubmit}
      />,
    );

    await tick();
    for (const ch of "hello") {
      stdin.write(ch);
      await tick();
    }

    const typedFrame = lastFrame() ?? "";
    // (1) "hello" appears exactly once — no overlapping/duplicated draft.
    expect(typedFrame).toContain("hello");
    expect((typedFrame.match(/hello/g) ?? []).length).toBe(1);

    // (2) Enter dispatches the run with the typed text and (3) clears the draft.
    stdin.write("\r");
    await tick();
    await tick();
    const afterFrame = lastFrame() ?? "";

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toBe("hello");
    expect(afterFrame).toContain("type a message"); // placeholder back = draft cleared
    expect((afterFrame.match(/hello/g) ?? []).length).toBe(0);
  });

  it("a real multi-line paste is still guarded (never auto-submits)", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <App caps={richCaps} viewport={{ cols: 120, rows: 40 }} initialPreset="chat" events={seedEvents} onSubmit={onSubmit} />,
    );
    await tick();
    stdin.write("line one\nline two"); // coalesced paste containing a newline
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
