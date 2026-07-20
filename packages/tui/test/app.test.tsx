import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  App,
  CapabilityProvider,
  Onboarding,
  ThemeProvider,
  type Capabilities,
  type UiEvent,
} from "../src/index.js";
import { BUILTIN_THEME_LIST } from "@nexuscode/theme";

/** A capable truecolor/unicode terminal for deterministic frames. */
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

const chatEvents: UiEvent[] = [
  { t: "session", id: "run1", provider: "anthropic", model: "Opus 4.8", ts: 1 },
  { t: "usage", lane: "main", inputTokens: 84200, outputTokens: 0, costUsd: 0.41 },
  { t: "text", lane: "main", delta: "Hello from the app shell" },
];

// Two-lane compare stream (fanned across anthropic + openai).
const compareEvents: UiEvent[] = [
  { t: "text", lane: "anthropic", delta: "Answer A" },
  { t: "usage", lane: "anthropic", inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
  { t: "done", lane: "anthropic", finishReason: "stop" },
  { t: "text", lane: "openai", delta: "Answer B" },
  { t: "done", lane: "openai", finishReason: "stop" },
];

// Nexus Noir accent (#22D3EE) as a truecolor SGR — proof a token reached Ink.
const NOIR_ACCENT_SGR = "38;2;34;211;238";

describe("<App> — interactive shell", () => {
  it("renders the chat preset with chrome, live text, and the HUD", () => {
    const { lastFrame } = render(
      <App caps={richCaps} viewport={{ cols: 120, rows: 40 }} initialPreset="chat" sessionName="quick" events={chatEvents} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[CHAT]");
    expect(frame).toContain("Opus 4.8");
    expect(frame).toContain("Conversation");
    expect(frame).toContain("Hello from the app shell");
    expect(frame).toContain("ctx");
    expect(frame).toContain("$0.41");
  });

  it("theme switch changes the resolved tokens (§4.1)", () => {
    const noir = render(
      <App caps={richCaps} viewport={{ cols: 120, rows: 40 }} themeId="nexus-noir" events={chatEvents} />,
    );
    const synth = render(
      <App caps={richCaps} viewport={{ cols: 120, rows: 40 }} themeId="synthwave-grid" events={chatEvents} />,
    );
    const noirFrame = noir.lastFrame() ?? "";
    const synthFrame = synth.lastFrame() ?? "";
    // Noir surfaces its cyan accent; swapping the theme re-skins it away.
    expect(noirFrame).toContain(NOIR_ACCENT_SGR);
    expect(synthFrame).not.toContain(NOIR_ACCENT_SGR);
    expect(synthFrame).not.toEqual(noirFrame);
  });

  it("compare preset shows one lane column per fanned-out provider (§2.9.3)", () => {
    const { lastFrame } = render(
      <App caps={richCaps} viewport={{ cols: 140, rows: 40 }} initialPreset="compare" events={compareEvents} />,
    );
    const frame = lastFrame() ?? "";
    // Both lanes present, each with its provider label + streamed answer.
    expect(frame).toContain("anthropic");
    expect(frame).toContain("openai");
    expect(frame).toContain("Answer A");
    expect(frame).toContain("Answer B");
  });

  it("opens the command palette overlay listing theme + layout actions (§6.5)", () => {
    const { lastFrame } = render(
      <App caps={richCaps} viewport={{ cols: 120, rows: 40 }} paletteOpen events={chatEvents} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Command Palette");
    expect(frame).toContain("theme:");
    expect(frame).toContain("layout:");
  });

  it("gates the workspace behind the first-run onboarding wizard (§8)", () => {
    const { lastFrame } = render(
      <App caps={richCaps} viewport={{ cols: 120, rows: 40 }} showOnboarding events={chatEvents} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("first run");
    // Onboarding is shown instead of the workspace conversation frame.
    expect(frame).not.toContain("Conversation");
  });
});

// ANSI strip so we can assert on the `▸` focus caret next to a lane title.
const ANSI = /\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");
// 40ms (not 0) so ink has really mounted and registered its input handlers before
// the next stdin.write lands. A 0ms tick is enough on a fast dev machine but races
// on slower CI runners, where the keystroke arrives before the handler exists and
// silently does nothing. Matches the other TUI test files.
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("keymap scope arbitration — compare digits + Tab (§6.1/§6.4/§2.7)", () => {
  // The compare lanes carry a `▸ N` focus caret on their titles (§2.9.3), so a
  // moved caret is proof of a lane jump. `1 anthropic` / `2 openai` = laneOrder.

  it("empty draft: `1`–`4` jump the compare lane and are NOT typed into the input", async () => {
    const { stdin, lastFrame } = render(
      <App caps={richCaps} viewport={{ cols: 140, rows: 40 }} initialPreset="compare" events={compareEvents} />,
    );
    await tick();
    // Lane 0 (anthropic) is focused by default — the `▸` caret sits on its title.
    expect(strip(lastFrame())).toContain("▸ 1");
    expect(strip(lastFrame())).not.toContain("▸ 2");

    stdin.write("2"); // empty draft → outer compare scope owns the digit
    await tick();
    const frame = strip(lastFrame());
    // Focus moved to lane 1 (openai); lane 0 is no longer caretted.
    expect(frame).toContain("▸ 2");
    expect(frame).not.toContain("▸ 1");
    // The composer swallowed the digit — the draft is still empty (placeholder),
    // never `…message…2`.
    expect(frame).toContain("type a message…");
    expect(frame).not.toContain("message…2");
  });

  it("composing draft: a digit is typed into the message and does NOT re-jump the lane", async () => {
    const { stdin, lastFrame } = render(
      <App caps={richCaps} viewport={{ cols: 140, rows: 40 }} initialPreset="compare" events={compareEvents} />,
    );
    await tick();
    stdin.write("a"); // draft now non-empty → composer owns subsequent keys
    await tick();
    stdin.write("2"); // must insert, must NOT jump the lane
    await tick();
    const frame = strip(lastFrame());
    expect(frame).toContain("a2"); // digit landed in the draft
    expect(frame).toContain("▸ 1"); // focus never moved off lane 0
    expect(frame).not.toContain("▸ 2");
  });

  it("Tab traverses panels only when the draft is empty; a composing Tab is the input scope's (§2.7)", async () => {
    // `agent` is a multi-pane preset — panel focus (a moving double-border /
    // `▸` caret) is observable in the frame.
    const agentEvents: UiEvent[] = [
      { t: "session", id: "run1", provider: "anthropic", model: "Opus 4.8", ts: 1 },
      { t: "text", lane: "main", delta: "Planning." },
    ];
    const { stdin, lastFrame } = render(
      <App caps={richCaps} viewport={{ cols: 150, rows: 44 }} initialPreset="agent" events={agentEvents} />,
    );
    await tick();
    const empty0 = strip(lastFrame());

    stdin.write("\t"); // empty draft → Tab traverses panels (focus ring moves)
    await tick();
    const afterEmptyTab = strip(lastFrame());
    expect(afterEmptyTab).not.toEqual(empty0); // focus visibly moved

    stdin.write("x"); // compose — the input scope now owns Tab
    await tick();
    const composed = strip(lastFrame());
    expect(composed).toContain("x");

    stdin.write("\t"); // Tab while composing → swallowed, no panel traversal
    await tick();
    const afterComposedTab = strip(lastFrame());
    expect(afterComposedTab).toEqual(composed); // frame unchanged
  });
});

describe("<Onboarding> — first-run wizard (§8)", () => {
  const themes = BUILTIN_THEME_LIST.map((t) => ({ id: t.meta.id, name: t.meta.name }));

  function wrapOnboarding(step: number): string {
    const { lastFrame } = render(
      <CapabilityProvider caps={richCaps}>
        <ThemeProvider>
          <Onboarding
            themes={themes}
            themeId="nexus-noir"
            onPickTheme={() => {}}
            onComplete={() => {}}
            step={step}
          />
        </ThemeProvider>
      </CapabilityProvider>,
    );
    return lastFrame() ?? "";
  }

  it("welcomes on the first step with the brand strand row", () => {
    const frame = wrapOnboarding(0);
    expect(frame).toContain("first run");
    expect(frame).toContain("terminal-first AI harness");
  });

  it("previews the 6 themes on the theme step", () => {
    const frame = wrapOnboarding(1);
    expect(frame).toContain("Choose a theme");
    expect(frame).toContain("Nexus Noir");
    expect(frame).toContain("Synthwave Grid");
  });

  it("shows the provider/keys hint step", () => {
    const frame = wrapOnboarding(2);
    expect(frame).toContain("Providers");
    expect(frame).toContain("nexus keys set");
  });
});
