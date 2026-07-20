/**
 * W15 REVALIDATION — full end-to-end TUI keystroke audit.
 *
 * Unlike the pure `onSubmit` mock test, this wires the App to a REAL engine
 * (mock provider) + live EventStore exactly as `runTui` does in production:
 * a keystroke-driven submit dispatches a real turn whose streamed chunks are
 * projected into the store the App renders. It asserts the four acceptance
 * criteria from the audit spec:
 *   (1) typed "hello" appears in the frame,
 *   (2) Enter dispatches a run to the engine AND clears the draft,
 *   (3) no overlapping/duplicated text on the input line,
 *   (4) the streamed response renders below the input.
 */
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry, createEngine } from "@nexuscode/core";
import { createMockAdapter } from "@nexuscode/provider-mock";
import {
  App,
  createEventStore,
  runTurn,
  type Capabilities,
  type UiMode,
} from "../src/index.js";

const richCaps: Partial<Capabilities> = {
  truecolor: true,
  colors256: true,
  unicode: true,
  noColor: false,
  screenReader: false,
  reducedMotion: true,
  isTTY: true,
  termDumb: false,
  width: 120,
  height: 40,
};

const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("W15 revalidate — real engine keystroke round-trip", () => {
  it("type hello + Enter → dispatches to engine, clears draft, streams response below", async () => {
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter());
    const engine = createEngine({ registry });
    const session = await engine.openSession();
    const store = createEventStore();

    let running = false;
    const submitted: string[] = [];
    const onSubmit = (text: string, _mode: UiMode): void => {
      submitted.push(text);
      if (running) return;
      running = true;
      void runTurn(session, store, { provider: "mock", model: "mock-fast", text })
        .finally(() => {
          running = false;
        });
    };

    const { stdin, lastFrame } = render(
      <App
        store={store}
        caps={richCaps}
        viewport={{ cols: 120, rows: 40 }}
        initialPreset="chat"
        sessionName="w15-reval"
        onSubmit={onSubmit}
      />,
    );

    await tick();

    // --- Type "hello" one char at a time (real stdin keystrokes).
    for (const ch of "hello") {
      stdin.write(ch);
      await tick();
    }

    const typed = lastFrame() ?? "";
    // (1) appears, (3) exactly once — no overlap/dup on the input line.
    expect(typed).toContain("hello");
    expect((typed.match(/hello/g) ?? []).length).toBe(1);

    // --- Press Enter (a lone CR): must submit, not insert a newline.
    stdin.write("\r");
    // give the async engine turn time to stream + settle
    await tick(60);
    await tick(60);
    await tick(60);

    const after = lastFrame() ?? "";

    // (2a) Enter dispatched exactly one run to the engine.
    expect(submitted).toEqual(["hello"]);

    // (2b) the draft cleared — placeholder returned, no lingering "hello" draft.
    expect(after).toContain("type a message");

    // (4) the streamed mock response rendered below the input.
    expect(after).toContain("[mock-fast] Echo: hello");

    // The store actually accumulated the run (engine was the source of truth).
    const view = store.getView();
    const finalText = view.lanes["main"]?.finalized.map((t) => t.text).join("") ?? "";
    expect(finalText).toContain("[mock-fast] Echo: hello");
    expect(view.totals.outputTokens).toBeGreaterThan(0);
  });

  it("Enter on an empty draft does nothing (no phantom dispatch)", async () => {
    const onSubmit = vi.fn();
    const { stdin } = render(
      <App caps={richCaps} viewport={{ cols: 120, rows: 40 }} initialPreset="chat" onSubmit={onSubmit} />,
    );
    await tick();
    stdin.write("\r");
    await tick();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
