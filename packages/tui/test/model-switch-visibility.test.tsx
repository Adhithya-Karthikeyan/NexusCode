/**
 * A `/model` / `/provider` switch must be VISIBLE on the default conversation
 * surface (bug fix).
 *
 * The reported bug: picking a model did nothing and said nothing. Two causes —
 * the CLI-side preflight rejected almost every pick (fixed in
 * `packages/cli/src/model-switch.ts`), and the rejection was then filed as an
 * `error` UiEvent that lands only in `view.notifications`, which the DEFAULT
 * `conversation` preset never renders (the notification rail exists only in the
 * multi-pane presets). So the picker closed and the user saw nothing at all.
 *
 * These tests drive the REAL App + composer keystrokes through ink-testing-library
 * and assert on what the terminal actually shows.
 */

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App, type AppProps, type Capabilities, type ModelChoice } from "../src/index.js";

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

const ENTER = "\r";
const DOWN = "\x1b[B";

async function type(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await tick();
  }
}

const MODELS: ModelChoice[] = [
  { provider: "mock", model: "mock-fast" },
  { provider: "mock", model: "mock-smart" },
];

function appProps(extra: Partial<AppProps> = {}): AppProps {
  return {
    caps: richCaps,
    viewport: { cols: 120, rows: 40 },
    onSubmit: vi.fn(),
    models: MODELS,
    providers: [{ id: "mock" }, { id: "openai" }],
    activeModel: "mock-fast",
    activeProvider: "mock",
    ...extra,
  };
}

/** Open `/model` and pick the SECOND row (mock-fast → mock-smart). */
async function pickSecondModel(stdin: { write: (s: string) => void }): Promise<void> {
  await type(stdin, "/model");
  stdin.write(ENTER); // open the picker
  await tick();
  await tick();
  stdin.write(DOWN);
  await tick();
  stdin.write(ENTER); // pick it
  await tick();
  await tick();
}

describe("a /model switch is visible on the conversation surface", () => {
  it("shows the host's receipt and moves the status bar onto the new model", async () => {
    const onModelChange = vi.fn((model: string, provider: string) => ({
      accepted: true as const,
      provider,
      model,
      contextMax: 1_000_000,
      reasoningSupported: true,
      receipt: `mock/mock-fast → ${provider}/${model}; preflight passed`,
    }));
    const { stdin, lastFrame } = render(<App {...(appProps({ onModelChange }))} />);
    await tick();
    expect(strip(lastFrame())).toContain("mock-fast");

    await pickSecondModel(stdin);

    expect(onModelChange).toHaveBeenCalledWith("mock-smart", "mock");
    const frame = strip(lastFrame());
    // The receipt is on screen …
    expect(frame).toContain("preflight passed");
    expect(frame).toContain("mock/mock-fast → mock/mock-smart");
    // … and the status bar now reads the NEW model.
    expect(frame).toContain("mock-smart");
  });

  it("shows the REASON when the host rejects the switch (was completely silent)", async () => {
    const onModelChange = vi.fn(() => ({
      accepted: false as const,
      provider: "mock",
      reason: "mock has no model mock-smart",
    }));
    const { stdin, lastFrame } = render(<App {...(appProps({ onModelChange }))} />);
    await tick();

    await pickSecondModel(stdin);

    const frame = strip(lastFrame());
    expect(frame).toContain("mock has no model mock-smart");
    // A rejected switch must NOT move the status bar onto the model it refused.
    expect(frame).not.toContain("mock-smart ");
    expect(frame).toContain("mock-fast");
  });

  it("surfaces a callback that throws instead of swallowing it", async () => {
    const onModelChange = vi.fn(() => {
      throw new Error("registry exploded");
    });
    const { stdin, lastFrame } = render(<App {...(appProps({ onModelChange }))} />);
    await tick();

    await pickSecondModel(stdin);

    expect(strip(lastFrame())).toContain("registry exploded");
  });

  it("clears the notice once the next turn is submitted", async () => {
    const onModelChange = vi.fn((model: string, provider: string) => ({
      accepted: true as const,
      provider,
      model,
      contextMax: 200_000,
      reasoningSupported: false,
      receipt: "switched for real",
    }));
    const { stdin, lastFrame } = render(<App {...(appProps({ onModelChange }))} />);
    await tick();

    await pickSecondModel(stdin);
    expect(strip(lastFrame())).toContain("switched for real");

    await type(stdin, "hello");
    stdin.write(ENTER);
    await tick();
    await tick();

    expect(strip(lastFrame())).not.toContain("switched for real");
  });
});

describe("/agent actually changes the role a turn is dispatched with", () => {
  it("submits under the picked role instead of a hard-coded CHAT", async () => {
    const onSubmit = vi.fn();
    const onRoleChange = vi.fn();
    const { stdin, lastFrame } = render(
      <App {...(appProps({ onSubmit, onRoleChange }))} />,
    );
    await tick();

    // Baseline: the default role is CHAT.
    await type(stdin, "first");
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenLastCalledWith("first", "CHAT");

    // /agent → AUTOPILOT (3rd row: CHAT, AGENT, AUTOPILOT).
    await type(stdin, "/agent");
    stdin.write(ENTER);
    await tick();
    await tick();
    expect(strip(lastFrame())).toContain("AUTOPILOT");
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN);
    await tick();
    stdin.write(ENTER);
    await tick();
    await tick();

    expect(onRoleChange).toHaveBeenCalledWith("AUTOPILOT");
    // The elevated role is called out — it lets tools write files.
    expect(strip(lastFrame())).toContain("may write files");

    // The NEXT turn is dispatched under AUTOPILOT, not CHAT.
    await type(stdin, "second");
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenLastCalledWith("second", "AUTOPILOT");
  });

  it("keeps an elevated role visible on the status bar after the notice clears", async () => {
    const onSubmit = vi.fn();
    const { stdin, lastFrame } = render(
      <App {...(appProps({ onSubmit, initialRole: "AUTOPILOT" }))} />,
    );
    await tick();
    // No notice yet — the role itself is on the bar.
    expect(strip(lastFrame())).toContain("AUTOPILOT");

    await type(stdin, "go");
    stdin.write(ENTER);
    await tick();
    expect(onSubmit).toHaveBeenLastCalledWith("go", "AUTOPILOT");
    expect(strip(lastFrame())).toContain("AUTOPILOT");
  });

  it("adds no role chrome in the default CHAT role", async () => {
    const { lastFrame } = render(<App {...(appProps())} />);
    await tick();
    // The status line stays clean; "CHAT" is the assumed default.
    expect(strip(lastFrame())).not.toContain("CHAT");
  });
});

describe("a /provider switch is visible too", () => {
  it("shows the receipt and lands on the model the host resolved", async () => {
    const onProviderChange = vi.fn((provider: string) => ({
      accepted: true as const,
      provider,
      model: "gpt-4o",
      contextMax: 128_000,
      reasoningSupported: false,
      receipt: `mock/mock-fast → ${provider}/gpt-4o; switched`,
    }));
    const { stdin, lastFrame } = render(<App {...(appProps({ onProviderChange }))} />);
    await tick();

    await type(stdin, "/provider");
    stdin.write(ENTER);
    await tick();
    await tick();
    stdin.write(DOWN); // mock → openai
    await tick();
    stdin.write(ENTER);
    await tick();
    await tick();

    expect(onProviderChange).toHaveBeenCalledWith("openai");
    const frame = strip(lastFrame());
    expect(frame).toContain("mock/mock-fast → openai/gpt-4o");
    expect(frame).toContain("gpt-4o");
  });
});
