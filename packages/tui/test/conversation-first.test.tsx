/**
 * Conversation-first surface (the Claude-Code-style DEFAULT) — headless via
 * ink-testing-library. Renders a realistic UiEvent stream (user msg → streaming
 * assistant markdown → tool-call line → done → status bar), asserts the clean
 * single-column layout (no pane box-drawing), verifies typing + Enter still SENDS
 * (the working input is not regressed), the slash autocomplete, the empty/onboarding
 * state, and the non-TTY linear-mode fallback.
 */

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { ProviderRegistry, createEngine } from "@nexuscode/core";
import { createMockAdapter } from "@nexuscode/provider-mock";
import {
  App,
  Conversation,
  SlashMenu,
  slashMatches,
  summarizeTool,
  CapabilityProvider,
  ThemeProvider,
  reduceEvents,
  runTui,
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

// A realistic single-turn stream: assistant streams Markdown (heading + list +
// fenced code), runs a tool, finalizes; then a second turn streams live.
const conversationEvents: UiEvent[] = [
  { t: "session", id: "run1", provider: "anthropic", model: "claude-opus-4", ts: 1 },
  { t: "usage", lane: "main", inputTokens: 12800, outputTokens: 340, costUsd: 0.21 },
  {
    t: "text",
    lane: "main",
    delta:
      "## Plan\n\nHere is the **approach**:\n\n- read the file\n- patch it\n\n```ts\nfunction add(a: number, b: number) {\n  return a + b\n}\n```\n",
  },
  { t: "tool_call", lane: "main", id: "t1", name: "fs_read", args: { path: "src/auth.ts" } },
  { t: "tool_result", lane: "main", id: "t1", ok: true, result: "ok" },
  { t: "diff", lane: "main", path: "src/auth.ts", patch: "@@ -1,2 +1,3 @@\n ctx\n-old\n+new\n+added\n" },
  { t: "done", lane: "main", finishReason: "stop" },
  { t: "text", lane: "main", delta: "Done — the change is applied." },
];

const prompts = ["refactor the auth module", "does it build?"];

describe("<Conversation> — clean, Claude-Code-style transcript", () => {
  it("renders user prompt, streaming markdown, an inline tool line, a diff summary + status bar", () => {
    const view = reduceEvents(conversationEvents);
    const { lastFrame } = render(
      wrap(
        <Conversation
          view={view}
          prompts={prompts}
          viewport={{ cols: 100, rows: 40 }}
          contextMax={200000}
        />,
      ),
    );
    const frame = strip(lastFrame());

    // User prompt echoed with the subtle `›` prefix.
    expect(frame).toContain("› refactor the auth module");
    // Assistant answer rendered as Markdown (heading + list + fenced code).
    expect(frame).toContain("Plan");
    expect(frame).toContain("read the file");
    expect(frame).toContain("function add"); // code block body
    // Inline, compact tool line (never a standing panel).
    expect(frame).toContain("↳ Read src/auth.ts");
    // Collapsed diff summary with +/- counts.
    expect(frame).toContain("↳ Edit src/auth.ts");
    expect(frame).toContain("+2");
    // The live (second) turn streams below.
    expect(frame).toContain("› does it build?");
    expect(frame).toContain("Done — the change is applied.");
    // Slim one-line status bar.
    expect(frame).toContain("◆ NexusCode");
    expect(frame).toContain("claude-opus-4");
    expect(frame).toContain("13.1k/200.0k"); // ctx used/max
    expect(frame).toContain("$0.21");
    // Pinned composer with the placeholder + submit hint.
    expect(frame).toContain("type a message");
    expect(frame).toContain("send");

    // CLEAN layout: no multi-pane box-drawing chrome anywhere.
    expect(frame).not.toContain("╔");
    expect(frame).not.toContain("║");
    expect(frame).not.toContain("Conversation"); // no pane title
  });

  it("shows a clean onboarding / empty state before the first turn", () => {
    const view = reduceEvents([
      { t: "session", id: "r", provider: "anthropic", model: "claude-opus-4", ts: 1 },
    ]);
    const { lastFrame } = render(
      wrap(<Conversation view={view} prompts={[]} viewport={{ cols: 100, rows: 40 }} />),
    );
    const frame = strip(lastFrame());
    expect(frame).toContain("NexusCode — ask anything.");
    expect(frame).toContain("/help for commands.");
    expect(frame).toContain("claude-opus-4"); // active model shown
  });

  it("streams the live turn with a cursor while in flight", () => {
    const view = reduceEvents([
      { t: "session", id: "r", provider: "anthropic", model: "claude-opus-4", ts: 1 },
      { t: "text", lane: "main", delta: "streaming now" },
    ]);
    const { lastFrame } = render(
      wrap(<Conversation view={view} viewport={{ cols: 100, rows: 40 }} />),
    );
    const frame = strip(lastFrame());
    expect(frame).toContain("streaming now");
    expect(frame).toContain("▮"); // static streaming cursor (reduced tier)
    expect(frame).toContain("streaming"); // status bar in-flight marker
  });
});

describe("summarizeTool + slash autocomplete", () => {
  it("maps common tool names to compact verbs", () => {
    expect(summarizeTool("fs_read", { path: "a.ts" })).toEqual({ verb: "Read", detail: "a.ts" });
    expect(summarizeTool("bash", { command: "npm test" })).toEqual({ verb: "$", detail: "npm test" });
    expect(summarizeTool("grep", { query: "TODO" })).toEqual({ verb: "Search", detail: "TODO" });
  });

  it("slashMatches filters by prefix and stops once an argument is typed", () => {
    expect(slashMatches("/mo").map((c) => c.name)).toEqual(["/model"]);
    expect(slashMatches("/t").map((c) => c.name)).toContain("/theme");
    expect(slashMatches("hello")).toEqual([]);
    expect(slashMatches("/model gpt")).toEqual([]); // argument typed → no menu
  });

  it("<SlashMenu> renders matching commands with descriptions", () => {
    const { lastFrame } = render(wrap(<SlashMenu draft="/c" />));
    const frame = strip(lastFrame());
    expect(frame).toContain("/context");
    expect(frame).toContain("/clear");
    expect(frame).toContain("/cost");
  });
});

describe("<App> defaults to the conversation surface + keeps the working input", () => {
  it("defaults to conversation (no pane chrome) and typing + Enter SENDS + echoes the prompt", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      // No initialPreset → the new conversation default.
      <App caps={richCaps} viewport={{ cols: 100, rows: 40 }} onSubmit={onSubmit} />,
    );
    await tick();
    // Empty state + clean layout (no pane borders).
    const empty = strip(lastFrame());
    expect(empty).toContain("ask anything");
    expect(empty).not.toContain("║");

    for (const ch of "hello") {
      stdin.write(ch);
      await tick();
    }
    const typed = strip(lastFrame());
    expect(typed).toContain("hello");
    expect((typed.match(/hello/g) ?? []).length).toBe(1); // no overlap/dup

    stdin.write("\r"); // Enter → deliberate submit
    await tick();
    await tick();
    const after = strip(lastFrame());

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toBe("hello");
    expect((onSubmit.mock.calls[0]?.[1] as UiMode)).toBe("CHAT");
    expect(after).toContain("› hello"); // prompt echoed into the transcript
    expect(after).toContain("type a message"); // draft cleared
  });

  it("end-to-end over a real (mock) engine: submit streams a response into the transcript", async () => {
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter());
    const engine = createEngine({ registry });
    const { runTurn, createEventStore } = await import("../src/index.js");
    const session = await engine.openSession();
    const store = createEventStore();

    let running = false;
    const onSubmit = (text: string): void => {
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
    stdin.write("\r");
    await tick(60);
    await tick(60);
    await tick(60);
    const after = strip(lastFrame());
    expect(after).toContain("› hello");
    expect(after).toContain("[mock-fast] Echo: hello"); // streamed answer below
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
