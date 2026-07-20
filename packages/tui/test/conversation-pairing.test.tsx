/**
 * Prompt↔turn pairing regression (HIGH blocker) — headless via ink-testing-library.
 *
 * The conversation surface used to pair `prompts[i]` with finalized turn `i` by
 * ARRAY POSITION. Any divergence between prompt count and finalized-turn count —
 * an interrupted turn, an `error` before `done`, or a prompt that merges into a
 * dangling live turn — shifted every later answer under the wrong prompt, and
 * because finalized turns commit to `<Static>` the corruption was permanent.
 *
 * The fix makes pairing INTRINSIC: the client injects a `prompt` marker into the
 * same append-only log, `reduceEvent` opens a turn stamped with that prompt (and
 * finalizes any dangling live turn first), and the view renders `turn.prompt`.
 * These tests drive a realistic stream (incl. an interrupted middle turn) and
 * assert every answer lands under its OWN prompt, plus the working keystroke
 * send + the non-TTY linear-mode fallback.
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { ProviderRegistry, createEngine } from "@nexuscode/core";
import { createMockAdapter } from "@nexuscode/provider-mock";
import {
  App,
  Conversation,
  CapabilityProvider,
  ThemeProvider,
  reduceEvents,
  runTui,
  createEventStore,
  runTurn,
  type Capabilities,
  type UiEvent,
  type UiMode,
} from "../src/index.js";

const richCaps: Partial<Capabilities> = {
  truecolor: true,
  colors256: true,
  unicode: true,
  noColor: false,
  screenReader: false,
  reducedMotion: true, // static → no leaked timers
  isTTY: true,
  termDumb: false,
  width: 100,
  height: 40,
};

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

function wrap(node: React.ReactNode, caps = richCaps): React.JSX.Element {
  return (
    <CapabilityProvider caps={caps}>
      <ThemeProvider>{node}</ThemeProvider>
    </CapabilityProvider>
  );
}

/** Assert `a` appears strictly before `b` in the frame (both must be present). */
function orderedBefore(frame: string, a: string, b: string): void {
  const ia = frame.indexOf(a);
  const ib = frame.indexOf(b);
  expect(ia, `"${a}" present`).toBeGreaterThanOrEqual(0);
  expect(ib, `"${b}" present`).toBeGreaterThanOrEqual(0);
  expect(ia, `"${a}" before "${b}"`).toBeLessThan(ib);
}

describe("prompt↔turn pairing is intrinsic (drift-proof)", () => {
  it("keeps every answer under its OWN prompt across an interrupted middle turn", () => {
    // Three prompts. The MIDDLE turn is interrupted (streams partial text, gets
    // NO `done`); the next prompt marker finalizes it. Positional pairing used
    // to slide the third answer under the second prompt — assert it does not.
    const events: UiEvent[] = [
      { t: "session", id: "run1", provider: "anthropic", model: "claude-opus-4", ts: 1 },
      { t: "prompt", lane: "main", id: "p0", text: "QUESTION-ALPHA" },
      { t: "text", lane: "main", delta: "ANSWER-ALPHA" },
      { t: "done", lane: "main", finishReason: "stop" },
      { t: "prompt", lane: "main", id: "p1", text: "QUESTION-BRAVO" },
      { t: "text", lane: "main", delta: "PARTIAL-BRAVO" }, // interrupted: no `done`
      { t: "prompt", lane: "main", id: "p2", text: "QUESTION-CHARLIE" },
      { t: "text", lane: "main", delta: "ANSWER-CHARLIE" },
      { t: "done", lane: "main", finishReason: "stop" },
    ];
    const view = reduceEvents(events);

    // Three finalized turns, each carrying the prompt that started it.
    const finalized = view.lanes["main"]?.finalized ?? [];
    expect(finalized.map((t) => t.prompt)).toEqual([
      "QUESTION-ALPHA",
      "QUESTION-BRAVO",
      "QUESTION-CHARLIE",
    ]);
    expect(finalized.map((t) => t.text)).toEqual([
      "ANSWER-ALPHA",
      "PARTIAL-BRAVO",
      "ANSWER-CHARLIE",
    ]);
    expect(finalized[1]?.finishReason).toBe("interrupted");

    const { lastFrame } = render(
      wrap(<Conversation view={view} viewport={{ cols: 100, rows: 40 }} />),
    );
    const frame = strip(lastFrame());

    // Each prompt echoed, each answer under its OWN prompt, in submit order.
    orderedBefore(frame, "› QUESTION-ALPHA", "ANSWER-ALPHA");
    orderedBefore(frame, "ANSWER-ALPHA", "› QUESTION-BRAVO");
    orderedBefore(frame, "› QUESTION-BRAVO", "PARTIAL-BRAVO");
    orderedBefore(frame, "PARTIAL-BRAVO", "› QUESTION-CHARLIE");
    orderedBefore(frame, "› QUESTION-CHARLIE", "ANSWER-CHARLIE");

    // The specific corruption the blocker described: the third answer must NOT
    // appear under the second prompt (i.e. before the third prompt echo).
    expect(frame.indexOf("ANSWER-CHARLIE")).toBeGreaterThan(frame.indexOf("› QUESTION-CHARLIE"));
    // No prompt is left dangling with someone else's answer.
    orderedBefore(frame, "› QUESTION-BRAVO", "PARTIAL-BRAVO");
  });

  it("does not merge a new prompt into a turn whose `error` arrived with no `done`", () => {
    const events: UiEvent[] = [
      { t: "session", id: "run1", provider: "anthropic", model: "claude-opus-4", ts: 1 },
      { t: "prompt", lane: "main", id: "p0", text: "FIRST-ASK" },
      { t: "text", lane: "main", delta: "started then " },
      { t: "error", lane: "main", code: "rate_limit", message: "429", retryable: true },
      { t: "prompt", lane: "main", id: "p1", text: "SECOND-ASK" },
      { t: "text", lane: "main", delta: "fresh answer" },
      { t: "done", lane: "main", finishReason: "stop" },
    ];
    const view = reduceEvents(events);
    const finalized = view.lanes["main"]?.finalized ?? [];
    // The errored turn finalized on its own; the second prompt started a NEW turn.
    expect(finalized).toHaveLength(2);
    expect(finalized[0]?.prompt).toBe("FIRST-ASK");
    expect(finalized[0]?.text).toBe("started then ");
    expect(finalized[0]?.finishReason).toBe("error:rate_limit");
    expect(finalized[1]?.prompt).toBe("SECOND-ASK");
    expect(finalized[1]?.text).toBe("fresh answer"); // not merged with the errored turn
  });

  it("finalizes the live turn on `error` across 3 prompts — no drift, error turn shown (not merged)", () => {
    // Three prompts; the SECOND turn ends in `error` (no `done`). The reducer
    // must finalize it immediately (§FIX-3) so the THIRD prompt starts a fresh
    // turn instead of merging into the errored one — the same drift hazard the
    // interrupted-turn test above covers, but for the `error` terminal.
    const events: UiEvent[] = [
      { t: "session", id: "run1", provider: "anthropic", model: "claude-opus-4", ts: 1 },
      { t: "prompt", lane: "main", id: "p0", text: "QUESTION-ONE" },
      { t: "text", lane: "main", delta: "ANSWER-ONE" },
      { t: "done", lane: "main", finishReason: "stop" },
      { t: "prompt", lane: "main", id: "p1", text: "QUESTION-TWO" },
      { t: "text", lane: "main", delta: "PARTIAL-TWO" },
      { t: "error", lane: "main", code: "server_error", message: "boom", retryable: false },
      { t: "prompt", lane: "main", id: "p2", text: "QUESTION-THREE" },
      { t: "text", lane: "main", delta: "ANSWER-THREE" },
      { t: "done", lane: "main", finishReason: "stop" },
    ];
    const view = reduceEvents(events);

    // Three DISTINCT finalized turns, each carrying the prompt that started it —
    // the error did not swallow QUESTION-TWO's turn nor bleed into THREE's.
    const finalized = view.lanes["main"]?.finalized ?? [];
    expect(finalized).toHaveLength(3);
    expect(finalized.map((t) => t.prompt)).toEqual([
      "QUESTION-ONE",
      "QUESTION-TWO",
      "QUESTION-THREE",
    ]);
    expect(finalized.map((t) => t.text)).toEqual(["ANSWER-ONE", "PARTIAL-TWO", "ANSWER-THREE"]);
    expect(finalized[1]?.finishReason).toBe("error:server_error");
    // No live turn left dangling after the final `done`.
    expect(view.lanes["main"]?.live).toBeNull();

    const { lastFrame } = render(
      wrap(<Conversation view={view} viewport={{ cols: 100, rows: 40 }} />),
    );
    const frame = strip(lastFrame());

    // Each prompt echoed, each answer under its OWN prompt, in submit order —
    // the errored turn's partial answer is SHOWN, not dropped or merged.
    orderedBefore(frame, "› QUESTION-ONE", "ANSWER-ONE");
    orderedBefore(frame, "ANSWER-ONE", "› QUESTION-TWO");
    orderedBefore(frame, "› QUESTION-TWO", "PARTIAL-TWO");
    orderedBefore(frame, "PARTIAL-TWO", "› QUESTION-THREE");
    orderedBefore(frame, "› QUESTION-THREE", "ANSWER-THREE");

    // The specific corruption this guards against: the third answer must NOT
    // appear under the second prompt (i.e. before the third prompt echo).
    expect(frame.indexOf("ANSWER-THREE")).toBeGreaterThan(frame.indexOf("› QUESTION-THREE"));
  });

  it("renders a realistic stream (markdown + inline tool + diff) with a correct frame + status bar", () => {
    const events: UiEvent[] = [
      { t: "session", id: "run1", provider: "anthropic", model: "claude-opus-4", ts: 1 },
      { t: "usage", lane: "main", inputTokens: 12800, outputTokens: 340, costUsd: 0.21 },
      { t: "prompt", lane: "main", id: "p0", text: "refactor the auth module" },
      {
        t: "text",
        lane: "main",
        delta: "## Plan\n\nHere is the **approach**:\n\n- read the file\n- patch it\n",
      },
      { t: "tool_call", lane: "main", id: "t1", name: "fs_read", args: { path: "src/auth.ts" } },
      { t: "tool_result", lane: "main", id: "t1", ok: true, result: "ok" },
      { t: "diff", lane: "main", path: "src/auth.ts", patch: "@@ -1,2 +1,3 @@\n ctx\n-old\n+new\n+added\n" },
      { t: "done", lane: "main", finishReason: "stop" },
      { t: "prompt", lane: "main", id: "p1", text: "does it build?" },
      { t: "text", lane: "main", delta: "Done — the change is applied." },
    ];
    const view = reduceEvents(events);
    const { lastFrame } = render(
      wrap(
        <Conversation view={view} viewport={{ cols: 100, rows: 40 }} contextMax={200000} />,
      ),
    );
    const frame = strip(lastFrame());

    expect(frame).toContain("› refactor the auth module");
    expect(frame).toContain("Plan");
    expect(frame).toContain("read the file");
    expect(frame).toContain("↳ Read src/auth.ts");
    expect(frame).toContain("↳ Edit src/auth.ts");
    expect(frame).toContain("+2");
    // The live (second) turn streams below, under its own prompt.
    orderedBefore(frame, "› does it build?", "Done — the change is applied.");
    // Slim one-line status bar, clean single-column (no pane chrome).
    expect(frame).toContain("◆ NexusCode");
    expect(frame).toContain("claude-opus-4");
    expect(frame).not.toContain("║");
  });
});

describe("working input is not regressed + prompt echoes via the log marker", () => {
  it("type hello + Enter → dispatches, echoes '› hello' once, streams the answer below, clears draft", async () => {
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
      void runTurn(session, store, { provider: "mock", model: "mock-fast", text }).finally(() => {
        running = false;
      });
    };

    const { stdin, lastFrame } = render(
      <App store={store} caps={richCaps} viewport={{ cols: 100, rows: 40 }} onSubmit={onSubmit} />,
    );
    await tick();
    for (const ch of "hello") {
      stdin.write(ch);
      await tick();
    }
    const typed = strip(lastFrame());
    expect(typed).toContain("hello");
    expect((typed.match(/hello/g) ?? []).length).toBe(1); // no overlap/dup on the input line

    stdin.write("\r");
    await tick(60);
    await tick(60);
    await tick(60);
    const after = strip(lastFrame());

    expect(submitted).toEqual(["hello"]);
    expect(after).toContain("› hello"); // echoed from the injected prompt marker
    expect((after.match(/› hello/g) ?? []).length).toBe(1); // exactly once, no double-echo
    expect(after).toContain("[mock-fast] Echo: hello"); // streamed answer below
    expect(after).toContain("type a message"); // draft cleared

    // The store owns the pairing: the finalized turn carries the prompt.
    const finalized = store.getView().lanes["main"]?.finalized ?? [];
    expect(finalized[0]?.prompt).toBe("hello");
    await engine.dispose();
  });
});

describe("non-TTY fallback (hard rule 4) still prints linear-mode", () => {
  it("refuses to mount the conversation TUI and prints the fallback", async () => {
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter());
    const engine = createEngine({ registry });
    let out = "";
    const fakeStdout = { write: (s: string) => { out += s; return true; } } as unknown as NodeJS.WriteStream;

    const result = await runTui(engine, {
      provider: "mock",
      model: "mock-fast",
      preset: "conversation",
      stdout: fakeStdout,
      capabilities: { ...richCaps, isTTY: false } as Capabilities,
      env: {},
    });

    expect(result.mounted).toBe(false);
    expect(result.reason).toBe("non-tty");
    expect(out).toContain("linear mode");
    await engine.dispose();
  });
});
