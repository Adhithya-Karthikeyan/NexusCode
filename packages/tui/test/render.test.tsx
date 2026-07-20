import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  CapabilityProvider,
  PaneFrame,
  StatusBar,
  StatusHud,
  ThemeProvider,
  TuiApp,
  reduceEvents,
  type Capabilities,
  type UiEvent,
} from "../src/index.js";

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
  width: 100,
  height: 40,
};

const events: UiEvent[] = [
  { t: "session", id: "run1", provider: "anthropic", model: "Opus 4.8", ts: 1 },
  { t: "route", chosen: "anthropic", reason: "explicit", candidates: ["anthropic"] },
  { t: "usage", lane: "main", inputTokens: 84200, outputTokens: 0, costUsd: 0.41 },
  { t: "text", lane: "main", delta: "Hello world" },
];

// Nexus Noir accent (#22D3EE) as a truecolor SGR — proof a token reached Ink.
const ACCENT_TRUECOLOR = "38;2;34;211;238";

/** Strip SGR color codes so plain-text width can be measured (chalk/Ink only
 * ever emit `ESC [ ... m` sequences in `lastFrame()`). */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function wrap(node: React.ReactNode, caps: Partial<Capabilities> = richCaps): React.JSX.Element {
  return (
    <CapabilityProvider caps={caps}>
      <ThemeProvider>{node}</ThemeProvider>
    </CapabilityProvider>
  );
}

describe("<Workspace> / <TuiApp> (Mode A scrollback)", () => {
  it("renders persistent chrome, panel frames, and the live region", () => {
    const { lastFrame } = render(
      <TuiApp caps={richCaps} viewport={{ cols: 100, rows: 40 }} preset="chat" sessionName="quick" events={events} />,
    );
    const frame = lastFrame() ?? "";
    // HeaderMark identity strip.
    expect(frame).toContain("[CHAT]");
    expect(frame).toContain("Opus 4.8");
    // Panel frames (chat medium = conversation + model rail).
    expect(frame).toContain("Conversation");
    expect(frame).toContain("Model");
    // Live region shows the in-flight text.
    expect(frame).toContain("Hello world");
    // HUD (Tier 0 at 100 cols): context gauge + session cost.
    expect(frame).toContain("ctx");
    expect(frame).toContain("84.2k");
    expect(frame).toContain("$0.41");
  });

  it("focuses the first panel and marks it with a caret (§2.7)", () => {
    const { lastFrame } = render(
      <TuiApp caps={richCaps} viewport={{ cols: 100, rows: 40 }} preset="chat" events={events} />,
    );
    expect(lastFrame() ?? "").toContain("▸ Conversation");
  });

  it("applies theme token colors to the output", () => {
    const { lastFrame } = render(
      <TuiApp caps={richCaps} viewport={{ cols: 100, rows: 40 }} preset="chat" events={events} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("["); // colors present
    expect(frame).toContain(ACCENT_TRUECOLOR); // the accent token reached Ink
  });

  it("degrades to ASCII glyphs on a non-unicode terminal", () => {
    const { lastFrame } = render(
      <TuiApp caps={{ ...richCaps, unicode: false }} viewport={{ cols: 100, rows: 40 }} preset="chat" events={events} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[CHAT]");
    expect(frame).not.toContain("◆"); // brand node downgraded to '*'
    expect(frame).toContain("*");
  });

  it("mounts a Mode B viewport preset without crashing", () => {
    const { lastFrame } = render(
      <TuiApp caps={richCaps} viewport={{ cols: 100, rows: 40 }} preset="dashboard" events={events} />,
    );
    const frame = lastFrame() ?? "";
    // Mode B pins the wordmark header (Nexus + Code render as adjacent tokens, so
    // an ANSI reset sits between them — assert the halves + the mode badge).
    expect(frame).toContain("Nexus");
    expect(frame).toContain("[CHAT]");
    expect(frame.length).toBeGreaterThan(0);
  });
});

describe("<StatusHud> tiers (§2.5)", () => {
  it("Tier 1 (≥120 cols) shows session + run cost and provider health", () => {
    const view = reduceEvents(events);
    const { lastFrame } = render(wrap(<StatusHud view={view} cols={150} contextMax={200000} />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("session");
    expect(frame).toContain("run");
    expect(frame).toContain("anthropic");
  });

  it("Tier 0 (compact) collapses to gauge + cost + active dot", () => {
    const view = reduceEvents(events);
    const { lastFrame } = render(wrap(<StatusHud view={view} cols={90} contextMax={200000} />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("ctx");
    expect(frame).toContain("$0.41");
    expect(frame).not.toContain("session");
  });
});

describe("<StatusBar> — single-line under long model ids", () => {
  const view = reduceEvents(events);
  // The worst-case realistic id from the layout finding.
  const LONG_MODEL = "anthropic.claude-3-7-sonnet-20250219-v1:0-extended-thinking";

  for (const cols of [40, 60, 80]) {
    it(`stays one row at ${cols} cols and never collides with 'ready'`, () => {
      const { lastFrame } = render(
        wrap(<StatusBar view={view} width={cols} modelOverride={LONG_MODEL} contextMax={200000} />),
      );
      const rows = (lastFrame() ?? "").split("\n");
      // The whole bar (left cluster + health cluster) fits on a single line.
      expect(rows.length).toBe(1);
      // The right-edge health state renders intact on that same row (not split
      // across a wrapped line). The seed view is streaming, so match either word.
      expect(rows[0]).toMatch(/streaming|ready/);
      // The model id is truncated, so the raw long id never appears in full.
      expect(rows[0]).not.toContain(LONG_MODEL);
    });
  }

  it("renders the full model id when it fits within the cap", () => {
    const { lastFrame } = render(
      wrap(<StatusBar view={view} width={80} modelOverride="Opus 4.8" contextMax={200000} />),
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Opus 4.8");
    expect(frame).toMatch(/streaming|ready/);
  });
});

describe("<StatusBar> — one clean line at 80/100/120 cols (layout regression)", () => {
  const view = reduceEvents(events);
  // The worst-case realistic id from the layout finding: a Bedrock-style fully
  // qualified id with a vendor prefix and trailing date/version noise.
  const LONG_MODEL = "anthropic.claude-3-7-sonnet-20250219-v1:0-extended-thinking";
  const SHORT_MODEL = "Opus 4.8";

  for (const width of [80, 100, 120]) {
    for (const [label, modelOverride] of [
      ["short id", SHORT_MODEL],
      ["long id", LONG_MODEL],
    ] as const) {
      it(`${label} at ${width} cols: single line, brand intact, no overflow`, () => {
        const { lastFrame } = render(
          wrap(<StatusBar view={view} width={width} modelOverride={modelOverride} contextMax={200000} />),
        );
        const frame = lastFrame() ?? "";
        const lines = frame.split("\n");

        // Never wraps — exactly one physical row.
        expect(lines.length).toBe(1);

        // Every rendered line fits within the terminal width (no spillover).
        const plainLines = lines.map(stripAnsi);
        for (const line of plainLines) {
          expect(line.length).toBeLessThanOrEqual(width);
        }

        // The brand is never clipped (the original bug rendered "NexuCod"); note
        // "Nexus" and "Code" are separately styled, so this must check the
        // ANSI-stripped text, not the raw (color-code-interleaved) frame.
        expect(plainLines.join("\n")).toContain("NexusCode");

        // The health cluster renders intact on the same row.
        expect(plainLines.join("\n")).toMatch(/streaming|ready/);
      });
    }
  }

  it("shortens a fully-qualified model id instead of blindly truncating it", () => {
    const { lastFrame } = render(
      wrap(<StatusBar view={view} width={80} modelOverride={LONG_MODEL} contextMax={200000} />),
    );
    const frame = lastFrame() ?? "";
    // The vendor prefix + trailing date/version noise are stripped; the
    // meaningful short name survives, ellipsized to show it was shortened.
    expect(frame).toContain("claude-3-7-sonnet…");
    expect(frame).not.toContain("anthropic.claude");
    expect(frame).not.toContain(LONG_MODEL);
  });

  it("shows a short model id verbatim (no shortening needed)", () => {
    const { lastFrame } = render(
      wrap(<StatusBar view={view} width={80} modelOverride={SHORT_MODEL} contextMax={200000} />),
    );
    expect(lastFrame() ?? "").toContain(SHORT_MODEL);
  });
});

describe("<PaneFrame>", () => {
  it("shows a focus caret and title when focused", () => {
    const { lastFrame } = render(wrap(<PaneFrame title="Files" focused />));
    expect(lastFrame() ?? "").toContain("▸ Files");
  });

  it("collapses to a 1-line rail (§2.6)", () => {
    const { lastFrame } = render(wrap(<PaneFrame title="Logs" collapsed railSummary="2 err" />));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Logs");
    expect(frame).toContain("2 err");
  });
});
