/**
 * `/model` picker is scoped to the ACTIVE provider (bug fix).
 *
 * The reported bug: `nexus -p <provider>` opened `/model` and dumped EVERY
 * provider's models (the whole global catalog). The fix scopes the picker to the
 * currently-selected provider, populating it from a live per-provider loader
 * (the `adapter.listModels()`-backed runtime helper) with a curated fallback.
 *
 * These tests drive the REAL App + composer keystrokes via ink-testing-library:
 *   - with active provider = mock, `/model` shows ONLY mock models (never
 *     gpt-4o / gemini / …);
 *   - after `/provider` switches to another provider, reopening `/model`
 *     reflects THAT provider's models.
 */

import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App, type Capabilities, type ModelChoice } from "../src/index.js";

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

/** The global catalog (all providers), used only as the STATIC fallback pool. */
const GLOBAL_MODELS: ModelChoice[] = [
  { provider: "mock", model: "mock-fast" },
  { provider: "mock", model: "mock-smart" },
  { provider: "mock", model: "mock-tools" },
  { provider: "openai", model: "gpt-4o" },
  { provider: "openai", model: "gpt-4o-mini" },
  { provider: "gemini", model: "gemini-2.0-flash" },
];

const PROVIDERS = [{ id: "mock" }, { id: "openai" }, { id: "gemini" }];

/** A fake runtime helper: returns each provider's REAL model list, scoped. */
const PER_PROVIDER: Record<string, { model: string; hint?: string }[]> = {
  mock: [{ model: "mock-fast" }, { model: "mock-smart" }, { model: "mock-tools" }],
  openai: [{ model: "gpt-4o" }, { model: "gpt-4o-mini" }],
  gemini: [{ model: "gemini-2.0-flash" }],
};

function makeLoader() {
  return vi.fn(async (pid: string) => PER_PROVIDER[pid] ?? []);
}

function appProps(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caps: richCaps,
    viewport: { cols: 120, rows: 40 },
    onSubmit: vi.fn(),
    models: GLOBAL_MODELS,
    providers: PROVIDERS,
    activeModel: "mock-fast",
    activeProvider: "mock",
    ...extra,
  };
}

describe("/model picker scopes to the active provider", () => {
  it("with active provider = mock, /model shows ONLY mock models (not gpt-4o / gemini)", async () => {
    const listModelsFor = makeLoader();
    const { stdin, lastFrame } = render(
      <App {...(appProps({ listModelsFor }) as never)} />,
    );
    await tick();

    await type(stdin, "/model");
    stdin.write(ENTER); // open the picker
    await tick();
    await tick();

    const picker = strip(lastFrame());
    // Header names the active provider.
    expect(picker).toContain("Select model · mock");
    // Only the ACTIVE provider (mock) models are listed …
    expect(picker).toContain("mock-fast");
    expect(picker).toContain("mock-smart");
    expect(picker).toContain("mock-tools");
    // … and NO other provider's models leak in.
    expect(picker).not.toContain("gpt-4o");
    expect(picker).not.toContain("gemini");
    // The live loader was consulted, and ONLY for the active provider.
    expect(listModelsFor).toHaveBeenCalledWith("mock");
    expect(listModelsFor.mock.calls.every((c) => c[0] === "mock")).toBe(true);
  });

  it("after /provider switches to openai, reopening /model reflects openai's models", async () => {
    const listModelsFor = makeLoader();
    const onProviderChange = vi.fn();
    const { stdin, lastFrame } = render(
      <App {...(appProps({ listModelsFor, onProviderChange }) as never)} />,
    );
    await tick();

    // 1) Switch the provider via /provider → openai (2nd row).
    await type(stdin, "/provider");
    stdin.write(ENTER); // open the provider picker
    await tick();
    await tick();
    expect(strip(lastFrame())).toContain("Select provider");
    stdin.write(DOWN); // mock → openai
    await tick();
    stdin.write(ENTER); // pick openai
    await tick();
    await tick();
    expect(onProviderChange).toHaveBeenCalledWith("openai");

    // 2) Reopen /model → now scoped to openai.
    await type(stdin, "/model");
    stdin.write(ENTER);
    await tick();
    await tick();

    const picker = strip(lastFrame());
    expect(picker).toContain("Select model · openai");
    expect(picker).toContain("gpt-4o");
    expect(picker).toContain("gpt-4o-mini");
    // The previously-active provider's models are gone from the LIST. (The status
    // bar still shows the lingering active model `mock-fast` — switching provider
    // does not auto-switch the model — so we assert on mock-only ids that would
    // ONLY appear inside a mock-scoped list.)
    expect(picker).not.toContain("mock-smart");
    expect(picker).not.toContain("mock-tools");
    expect(picker).not.toContain("gemini");
    // The loader was called for openai after the switch.
    expect(listModelsFor).toHaveBeenCalledWith("openai");
  });
});
