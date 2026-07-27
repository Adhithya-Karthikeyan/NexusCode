/**
 * Cost-honesty tests (companion to the fix in `@nexuscode/core`'s
 * `projection.ts` and `@nexuscode/session`'s session-tally aggregation): an
 * unpriced model must never be reported as a confident `$0.00` — that's
 * indistinguishable from a real free run and silently misrepresents a paid
 * call. `formatCostUsd`/`costIsIncomplete` are the CLI's trailer/JSON
 * rendering seam for that distinction (compare/race/consensus/chain).
 */

import { describe, expect, it } from "vitest";
import type { RunResult } from "@nexuscode/core";
import { costIsIncomplete, formatCostUsd } from "../src/commands.js";

function run(overrides: Partial<RunResult["usage"]>): RunResult {
  return {
    runId: `run_${Math.random()}`,
    adapterId: "mock",
    model: "mock-fast",
    status: "ok",
    text: "ok",
    toolCalls: [],
    diffs: [],
    usage: { inputTokens: 10, outputTokens: 5, ...overrides },
  };
}

describe("formatCostUsd — an unpriced model reads as unknown, never $0.00", () => {
  it("null/undefined renders as unpriced, not $0.000000", () => {
    expect(formatCostUsd(undefined)).toBe("unpriced");
    expect(formatCostUsd(null)).toBe("unpriced");
  });

  it("a priced model's real computed cost is unchanged", () => {
    expect(formatCostUsd(0.004321)).toBe("$0.004321");
  });

  it("a genuinely free run (costUsd: 0) reads as zero, not conflated with unpriced", () => {
    expect(formatCostUsd(0)).toBe("$0.000000");
    expect(formatCostUsd(0)).not.toBe("unpriced");
  });
});

describe("costIsIncomplete — a mixed lane set must be flagged, not presented as a confident total", () => {
  it("all lanes priced: not incomplete", () => {
    const runs = [run({ costUsd: 0.01 }), run({ costUsd: 0.02 })];
    expect(costIsIncomplete(runs)).toBe(false);
  });

  it("all lanes unpriced (uniformly unknown): not flagged 'incomplete' — it's just fully unknown", () => {
    const runs = [run({}), run({})];
    expect(costIsIncomplete(runs)).toBe(false);
  });

  it("one priced + one unpriced lane: flagged incomplete", () => {
    const runs = [run({ costUsd: 0.01 }), run({})];
    expect(costIsIncomplete(runs)).toBe(true);
  });

  it("a reportedCostUsd (CLI-self-reported) counts as priced", () => {
    const runs = [run({ reportedCostUsd: 0.03 }), run({})];
    expect(costIsIncomplete(runs)).toBe(true);
  });

  it("mock's genuine $0 cost does not trip the incomplete flag alongside a priced lane", () => {
    const runs = [run({ costUsd: 0 }), run({ costUsd: 0.05 })];
    expect(costIsIncomplete(runs)).toBe(false);
  });
});
