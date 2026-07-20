/**
 * Layout geometry — the invariants the pane redesign exists to hold.
 *
 * The original bug this guards: the pane tree was handed to Yoga with only
 * `flexGrow`/`flexBasis`, so a pane's *content* could set its width. At 100
 * columns the `dashboard` preset rendered 24 lines up to 115 columns wide, and
 * several panes drew a full-width top border over body rows that stopped short,
 * leaving ragged `││` seams. Both are now structurally impossible: widths are
 * resolved to exact integers before render, and every frame is asserted to fit.
 */

import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import {
  MIN_PANE_WIDTH,
  PANE_GAP,
  TuiApp,
  distribute,
  layoutTree,
  buildPreset,
  selectResponsiveTree,
  truncate,
  type Capabilities,
  type Size,
  type UiEvent,
} from "../src/index.js";

const richCaps: Partial<Capabilities> = {
  truecolor: true,
  colors256: true,
  unicode: true,
  noColor: false,
  isTTY: true,
  termDumb: false,
};

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const size = (basis: number, grow: number, min: number): Size => ({ basis, grow, min });

describe("distribute()", () => {
  it("apportions the full budget exactly, gaps included", () => {
    for (const total of [40, 63, 80, 100, 137, 200]) {
      const specs = [size(0, 3, 40), size(26, 1, 20), size(22, 1, 18)];
      const spans = distribute(total, specs, PANE_GAP);
      const live = spans.filter((s) => s > 0);
      const used = live.reduce((a, b) => a + b, 0) + PANE_GAP * Math.max(0, live.length - 1);
      expect(used, `total=${total}`).toBe(total);
    }
  });

  it("never seats a kept pane below its minimum", () => {
    const specs = [size(0, 3, 40), size(26, 1, 20)];
    for (const total of [60, 61, 62, 80, 120]) {
      const spans = distribute(total, specs, PANE_GAP);
      spans.forEach((span, i) => {
        if (span > 0) expect(span, `total=${total} pane=${i}`).toBeGreaterThanOrEqual(specs[i]!.min);
      });
    }
  });

  it("drops the least-growable pane rather than squeezing everything", () => {
    // 40 columns cannot seat a 40-min conversation AND a 20-min rail.
    const spans = distribute(40, [size(0, 3, 30), size(26, 1, 20)], PANE_GAP);
    expect(spans[1]).toBe(0); // the grow:1 rail yields
    expect(spans[0]).toBe(40); // the conversation keeps the whole budget
  });

  it("always leaves at least one pane standing", () => {
    const spans = distribute(10, [size(0, 1, 40), size(0, 1, 40), size(0, 1, 40)], PANE_GAP);
    expect(spans.filter((s) => s > 0)).toHaveLength(1);
  });

  it("returns all-zero for a non-positive budget instead of negative spans", () => {
    expect(distribute(0, [size(0, 1, 8), size(0, 1, 8)], PANE_GAP)).toEqual([0, 0]);
  });
});

describe("layoutTree()", () => {
  it("keeps every pane inside the terminal, for every preset and width", () => {
    for (const preset of ["chat", "agent", "compare", "dashboard"] as const) {
      const layout = buildPreset(preset);
      for (const cols of [60, 80, 100, 120, 140]) {
        const tree = selectResponsiveTree(layout, cols);
        const map = layoutTree(tree, { width: cols, height: 24 });
        for (const [id, rect] of map) {
          expect(rect.width, `${preset}@${cols} node=${id}`).toBeLessThanOrEqual(cols);
          expect(rect.width, `${preset}@${cols} node=${id}`).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it("gives a visible pane enough room to be worth drawing", () => {
    const layout = buildPreset("dashboard");
    const tree = selectResponsiveTree(layout, 100);
    const map = layoutTree(tree, { width: 100, height: 30 });
    for (const [id, rect] of map) {
      if (rect.width > 0) {
        expect(rect.width, `node=${id}`).toBeGreaterThanOrEqual(Math.min(MIN_PANE_WIDTH, 100));
      }
    }
  });
});

describe("truncate()", () => {
  it("never exceeds the cap and marks the cut", () => {
    expect(truncate("Tool Activity", 8)).toBe("Tool Ac…");
    expect(truncate("Tool Activity", 8)).toHaveLength(8);
    expect(truncate("Logs", 8)).toBe("Logs");
    expect(truncate("Tool Activity", 8, false)).toHaveLength(8);
    expect(truncate("anything", 0)).toBe("");
  });
});

describe("rendered frames fit the terminal (no overflow, no ragged seams)", () => {
  const events: UiEvent[] = [
    { t: "session", id: "r1", provider: "anthropic", model: "claude-opus-4-8", ts: 1 },
    { t: "prompt", lane: "main", id: "p1", text: "Refactor the session token and add an expiry." },
    {
      t: "text",
      lane: "main",
      // Long unbroken tokens + Markdown: the shapes most likely to overflow.
      delta:
        "Done.\n\n## What changed\n\n- `createSession` now uses `randomBytes(32)` with base64url encoding\n\n```ts\nconst token = randomBytes(32).toString(\"base64url\");\n```\n",
    },
    { t: "tool_call", lane: "main", id: "t1", name: "bash", args: { command: "npm test -- packages/auth --reporter=dot" } },
    { t: "tool_result", lane: "main", id: "t1", ok: true, result: "ok" },
    { t: "usage", lane: "main", inputTokens: 84200, outputTokens: 900, costUsd: 0.41 },
    { t: "done", lane: "main", finishReason: "stop" },
  ];

  for (const preset of ["chat", "agent", "compare", "dashboard"] as const) {
    for (const [cols, rows] of [
      [60, 20],
      [80, 24],
      [100, 30],
      [140, 40],
    ] as const) {
      it(`${preset} at ${cols}x${rows} never renders past column ${cols}`, () => {
        const { lastFrame } = render(
          <TuiApp
            caps={{ ...richCaps, width: cols, height: rows }}
            viewport={{ cols, rows }}
            preset={preset}
            sessionName="refactor-auth"
            events={events}
            contextMax={200000}
            inputActive={false}
          />,
        );
        const lines = stripAnsi(lastFrame() ?? "").split("\n");
        const over = lines.filter((l) => l.length > cols);
        expect(
          over,
          `${preset}@${cols}: ${over.length} line(s) overflow — e.g. ${JSON.stringify(over[0]?.slice(0, 120))}`,
        ).toHaveLength(0);
      });
    }
  }
});
