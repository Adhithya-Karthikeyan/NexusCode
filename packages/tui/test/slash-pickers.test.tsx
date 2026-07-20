/**
 * Slash-command menu + interactive pickers + layout overhaul (task A/B/C).
 * Headless via ink-testing-library. Drives the REAL composer keystrokes:
 *  - typing "/" opens the command menu (command names in the frame);
 *  - "/mod" filters down to /model;
 *  - opening /model shows a grouped model list and selecting one updates the
 *    active model in the status bar (live switch);
 *  - opening /theme and selecting applies the theme;
 *  - frames at 80 + 120 cols are clean (input + status present, no overflow,
 *    overlays render above the input without overlapping the status bar).
 */

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import {
  App,
  Picker,
  CapabilityProvider,
  ThemeProvider,
  buildSlashCommands,
  type Capabilities,
  type ModelChoice,
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

const ANSI = /\x1b\[[0-9;]*m/g;
const strip = (s: string | undefined): string => (s ?? "").replace(ANSI, "");
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms));

const MODELS: ModelChoice[] = [
  { provider: "anthropic", model: "claude-opus-4", hint: "200k" },
  { provider: "anthropic", model: "claude-sonnet-4", hint: "200k" },
  { provider: "openai", model: "gpt-4o", hint: "128k" },
  { provider: "openai", model: "gpt-4o-mini", hint: "128k" },
];
const PROVIDERS = [{ id: "anthropic" }, { id: "openai" }, { id: "mock" }];
const TOOLS = [
  { name: "fs_read", description: "read a file" },
  { name: "bash", description: "run a command" },
];

function appProps(cols: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caps: { ...richCaps, width: cols },
    viewport: { cols, rows: 40 },
    onSubmit: vi.fn(),
    models: MODELS,
    providers: PROVIDERS,
    tools: TOOLS,
    activeModel: "claude-opus-4",
    activeProvider: "anthropic",
    ...extra,
  };
}

async function type(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick();
  }
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const TAB = "\t";
const ESC = "\x1b";

describe("slash-command menu", () => {
  it("typing '/' shows the command menu with the real command names", async () => {
    const { stdin, lastFrame } = render(<App {...(appProps(120) as never)} />);
    await tick();
    await type(stdin, "/");
    const frame = strip(lastFrame());
    expect(frame).toContain("/model");
    expect(frame).toContain("/theme");
    expect(frame).toContain("/provider");
    expect(frame).toContain("/help");
    // descriptions render alongside the names
    expect(frame).toContain("switch the active model");
  });

  it("typing '/mod' filters the menu down to /model", async () => {
    const { stdin, lastFrame } = render(<App {...(appProps(120) as never)} />);
    await tick();
    await type(stdin, "/mod");
    const frame = strip(lastFrame());
    expect(frame).toContain("/model");
    expect(frame).not.toContain("/theme");
    expect(frame).not.toContain("/provider");
  });

  it("Esc closes the menu and clears the draft", async () => {
    const { stdin, lastFrame } = render(<App {...(appProps(120) as never)} />);
    await tick();
    await type(stdin, "/mod");
    stdin.write(ESC);
    await tick();
    const frame = strip(lastFrame());
    expect(frame).not.toContain("/model");
    expect(frame).toContain("type a message"); // draft cleared, placeholder back
  });
});

describe("interactive pickers over real data", () => {
  it("opening /model shows ONLY the active provider's models (not the global catalog) and Enter switches live", async () => {
    const onModelChange = vi.fn();
    const { stdin, lastFrame } = render(
      <App {...(appProps(120, { onModelChange }) as never)} />,
    );
    await tick();
    // Baseline status bar shows the active model.
    expect(strip(lastFrame())).toContain("claude-opus-4");

    await type(stdin, "/model");
    stdin.write(ENTER); // choose the highlighted /model command → opens the picker
    await tick();
    await tick();

    const picker = strip(lastFrame());
    // Header names the provider being listed.
    expect(picker).toContain("Select model · anthropic");
    // The ACTIVE provider (anthropic) models are shown …
    expect(picker).toContain("claude-opus-4");
    expect(picker).toContain("claude-sonnet-4");
    // … and NO other provider's models leak in (the reported bug).
    expect(picker).not.toContain("gpt-4o");
    expect(picker).not.toContain("openai");
    // Subtle footer teaches how to change provider.
    expect(picker).toContain("/provider to switch provider");

    // Move down to the other anthropic model and select it.
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    await tick();

    const after = strip(lastFrame());
    expect(onModelChange).toHaveBeenCalledTimes(1);
    const picked = onModelChange.mock.calls[0]?.[0] as string;
    expect(picked).toBe("claude-sonnet-4");
    const pickedProvider = onModelChange.mock.calls[0]?.[1] as string;
    expect(pickedProvider).toBe("anthropic");
    // Status bar now reflects the newly-picked model (live switch), picker closed.
    expect(after).toContain(picked);
    expect(after).not.toContain("Select model");
    expect(after).toContain("type a message"); // back to the composer
  });

  it("opening /theme and selecting a theme applies it live", async () => {
    const onThemeChange = vi.fn();
    const { stdin, lastFrame } = render(
      <App {...(appProps(120, { onThemeChange }) as never)} />,
    );
    await tick();
    await type(stdin, "/theme");
    stdin.write(ENTER); // open the theme picker
    await tick();
    await tick();
    const picker = strip(lastFrame());
    expect(picker).toContain("Select theme");
    // The built-in theme names surface in the list.
    expect(picker.toLowerCase()).toContain("nexus");

    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER); // apply the highlighted theme
    await tick();
    await tick();

    expect(onThemeChange).toHaveBeenCalledTimes(1);
    const after = strip(lastFrame());
    expect(after).not.toContain("Select theme"); // picker closed
    expect(after).toContain("type a message");
  });

  it("Tab completes the highlighted command into the draft", async () => {
    const { stdin, lastFrame } = render(<App {...(appProps(120) as never)} />);
    await tick();
    await type(stdin, "/th");
    stdin.write(TAB);
    await tick();
    const frame = strip(lastFrame());
    // Draft is completed to "/theme " (an argument space → menu closes).
    expect(frame).toContain("/theme");
    expect(frame).not.toContain("change the color theme"); // menu closed
  });
});

describe("<Picker> component — filter + current highlight", () => {
  it("filters as you type and cancels on Esc", async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const items = MODELS.map((m) => ({ label: m.model, value: m.model, group: m.provider }));
    const { stdin, lastFrame } = render(
      <CapabilityProvider caps={richCaps}>
        <ThemeProvider>
          <Picker items={items} title="Select model" onSelect={onSelect} onCancel={onCancel} />
        </ThemeProvider>
      </CapabilityProvider>,
    );
    await tick();
    await type(stdin, "gpt");
    const frame = strip(lastFrame());
    expect(frame).toContain("gpt-4o");
    expect(frame).not.toContain("claude-opus-4");
    stdin.write(ENTER);
    await tick();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]?.[0]).toBe("gpt-4o");
  });
});

describe("registry construction from real data", () => {
  it("builds option-bearing commands whose providers return real items", async () => {
    const commands = buildSlashCommands({
      themes: [{ id: "nexus-noir", name: "Nexus Noir", mode: "dark", swatch: "#7cf" }],
      currentThemeId: "nexus-noir",
      onPickTheme: () => {},
      models: MODELS,
      currentModel: "claude-opus-4",
      currentProvider: "anthropic",
      onPickModel: () => {},
      providers: PROVIDERS,
      onPickProvider: () => {},
      tools: TOOLS,
      onClear: () => {},
      onNewSession: () => {},
      onQuit: () => {},
    });
    const model = commands.find((c) => c.name === "/model")!;
    const items = await model.optionsProvider!();
    // Scoped to the ACTIVE provider (anthropic) only — NOT the 4-item global list.
    expect(items.length).toBe(2);
    expect(items.every((i) => i.group === undefined)).toBe(true); // no cross-provider group dump
    expect(items.map((i) => i.label)).toEqual(["claude-opus-4", "claude-sonnet-4"]);
    expect(items.some((i) => i.current)).toBe(true);
    // Header + footer name the provider and teach the switch command.
    expect(model.pickerTitle).toBe("Select model · anthropic");
    expect(model.pickerFooter).toBe("/provider to switch provider");
    const clear = commands.find((c) => c.name === "/clear")!;
    expect(clear.optionsProvider).toBeUndefined(); // plain command
  });

  it("/model queries the live provider list when a loader is wired, and falls back to curated on failure", async () => {
    const build = (
      currentProvider: string,
      loader?: (pid: string) => Promise<{ model: string; hint?: string }[]>,
    ) =>
      buildSlashCommands({
        themes: [{ id: "nexus-noir", name: "Nexus Noir", mode: "dark" }],
        currentThemeId: "nexus-noir",
        onPickTheme: () => {},
        models: MODELS,
        currentModel: "claude-opus-4",
        currentProvider,
        onPickModel: () => {},
        ...(loader ? { listModelsForProvider: loader } : {}),
        providers: PROVIDERS,
        onPickProvider: () => {},
        tools: TOOLS,
        onClear: () => {},
        onNewSession: () => {},
        onQuit: () => {},
      });

    // Live loader returns the provider's REAL models → those win over the static pool.
    const live = vi.fn(async (pid: string) => {
      expect(pid).toBe("anthropic"); // called with the ACTIVE provider only
      return [{ model: "claude-live-1" }, { model: "claude-live-2" }];
    });
    const liveItems = await build("anthropic", live).find((c) => c.name === "/model")!.optionsProvider!();
    expect(live).toHaveBeenCalledTimes(1);
    expect(liveItems.map((i) => i.label)).toEqual(["claude-live-1", "claude-live-2"]);

    // A failing loader degrades gracefully to the curated static pool (scoped).
    const boom = vi.fn(async () => {
      throw new Error("offline");
    });
    const fallbackItems = await build("openai", boom).find((c) => c.name === "/model")!.optionsProvider!();
    expect(boom).toHaveBeenCalledTimes(1);
    expect(fallbackItems.map((i) => i.label)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });
});

describe("layout overhaul — clean at 80 and 120 cols", () => {
  for (const cols of [80, 100, 120]) {
    it(`renders a clean frame at ${cols} cols (input + status present, no overflow, no overlap)`, async () => {
      const { stdin, lastFrame } = render(<App {...(appProps(cols) as never)} />);
      await tick();
      await type(stdin, "explain the layout in one line");
      const frame = strip(lastFrame() ?? "");
      const lines = frame.split("\n");
      // No line overflows the terminal width.
      for (const line of lines) expect(line.length).toBeLessThanOrEqual(cols);
      // Status bar + composer both present and not collided.
      expect(frame).toContain("◆ NexusCode");
      expect(frame).toContain("claude-opus-4");
      expect(frame).toContain("explain the layout in one line"); // draft visible
      // No leftover multi-pane box chrome.
      expect(frame).not.toContain("║");
    });
  }

  it("the menu overlay renders above the input without overlapping the status bar", async () => {
    const cols = 120;
    const { stdin, lastFrame } = render(<App {...(appProps(cols) as never)} />);
    await tick();
    await type(stdin, "/");
    const frame = strip(lastFrame() ?? "");
    const lines = frame.split("\n");
    // The status bar is the line carrying the $cost (the empty state does not).
    const statusIdx = lines.findIndex((l) => l.includes("NexusCode") && l.includes("$"));
    const menuIdx = lines.findIndex((l) => l.includes("/model"));
    // The composer hint row (below the input) anchors the bottom of the chrome.
    const hintIdx = lines.findIndex((l) => l.includes("send") && l.includes("commands"));
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(menuIdx).toBeGreaterThanOrEqual(0);
    expect(hintIdx).toBeGreaterThanOrEqual(0);
    // status bar sits above the menu, which sits above the composer + its hint.
    expect(statusIdx).toBeLessThan(menuIdx);
    expect(menuIdx).toBeLessThan(hintIdx);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(cols);
  });
});
