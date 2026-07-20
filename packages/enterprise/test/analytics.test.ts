/**
 * Usage-analytics tests: aggregation totals per provider / model / day are
 * correct; cost is derived via the frozen `computeCost` from a pricing resolver
 * when an entry has no pre-computed cost; `run_summary` ingestion attributes to a
 * principal; day/week/month bucketing groups correctly; and CSV/JSON export
 * round-trips the report grain.
 */

import { describe, expect, it } from "vitest";
import type { Pricing } from "@nexuscode/shared";
import {
  UsageStore,
  bucketOf,
  toCsv,
  toJson,
  type PricingResolver,
  type RunSummaryLike,
  type UsageEntry,
} from "../src/index.js";

// Two UTC days: 2026-01-01 and 2026-01-02.
const DAY1 = Date.UTC(2026, 0, 1, 10, 0, 0);
const DAY1b = Date.UTC(2026, 0, 1, 23, 59, 0);
const DAY2 = Date.UTC(2026, 0, 2, 0, 30, 0);

const pricing: PricingResolver = (provider, model): Pricing | undefined => {
  if (provider === "openai" && model === "gpt-x") {
    return { inputPerMTok: 1, outputPerMTok: 2 }; // $/1M tok
  }
  if (provider === "anthropic" && model === "claude-y") {
    return { inputPerMTok: 3, outputPerMTok: 6 };
  }
  return undefined;
};

function seed(): UsageStore {
  const store = new UsageStore({ pricing });
  const entries: UsageEntry[] = [
    // openai/gpt-x, day 1: cost = (1M*1 + 1M*2)/1e6 = 3.0
    {
      ts: DAY1,
      principal: "alice",
      role: "dev",
      provider: "openai",
      model: "gpt-x",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    },
    // openai/gpt-x, day 1 again: cost = (500k*1 + 0)/1e6 = 0.5
    {
      ts: DAY1b,
      principal: "bob",
      role: "ops",
      provider: "openai",
      model: "gpt-x",
      usage: { inputTokens: 500_000, outputTokens: 0 },
    },
    // anthropic/claude-y, day 2: cost = (1M*3 + 1M*6)/1e6 = 9.0
    {
      ts: DAY2,
      principal: "alice",
      role: "dev",
      provider: "anthropic",
      model: "claude-y",
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    },
  ];
  store.recordAll(entries);
  return store;
}

describe("usage aggregation", () => {
  it("computes grand totals with computeCost-derived cost", () => {
    const report = seed().report({ window: "day" });
    expect(report.totals.count).toBe(3);
    expect(report.totals.inputTokens).toBe(2_500_000);
    expect(report.totals.outputTokens).toBe(2_000_000);
    // 3.0 + 0.5 + 9.0
    expect(report.totals.costUsd).toBeCloseTo(12.5, 6);
  });

  it("breaks down per provider", () => {
    const report = seed().report({ window: "day" });
    expect(report.byProvider.openai!.count).toBe(2);
    expect(report.byProvider.openai!.inputTokens).toBe(1_500_000);
    expect(report.byProvider.openai!.costUsd).toBeCloseTo(3.5, 6);
    expect(report.byProvider.anthropic!.count).toBe(1);
    expect(report.byProvider.anthropic!.costUsd).toBeCloseTo(9.0, 6);
  });

  it("breaks down per model", () => {
    const report = seed().report({ window: "day" });
    expect(report.byModel["gpt-x"]!.count).toBe(2);
    expect(report.byModel["claude-y"]!.count).toBe(1);
    expect(report.byModel["gpt-x"]!.outputTokens).toBe(1_000_000);
  });

  it("breaks down per day bucket (UTC)", () => {
    const report = seed().report({ window: "day" });
    expect(Object.keys(report.byBucket).sort()).toEqual(["2026-01-01", "2026-01-02"]);
    expect(report.byBucket["2026-01-01"]!.count).toBe(2);
    expect(report.byBucket["2026-01-01"]!.costUsd).toBeCloseTo(3.5, 6);
    expect(report.byBucket["2026-01-02"]!.count).toBe(1);
  });

  it("breaks down per principal and role", () => {
    const report = seed().report({ window: "day" });
    expect(report.byPrincipal.alice!.count).toBe(2);
    expect(report.byPrincipal.bob!.count).toBe(1);
    expect(report.byRole.dev!.count).toBe(2);
    expect(report.byRole.ops!.count).toBe(1);
  });

  it("collapses buckets for week and month windows", () => {
    const week = seed().report({ window: "week" });
    // Both days fall in the same ISO week (2026-W01).
    expect(Object.keys(week.byBucket)).toEqual(["2026-W01"]);
    expect(week.byBucket["2026-W01"]!.count).toBe(3);

    const month = seed().report({ window: "month" });
    expect(Object.keys(month.byBucket)).toEqual(["2026-01"]);
    expect(month.byBucket["2026-01"]!.count).toBe(3);
  });

  it("filters the report by provider and time", () => {
    const report = seed().report({ window: "day", provider: "openai" });
    expect(report.totals.count).toBe(2);
    expect(report.totals.costUsd).toBeCloseTo(3.5, 6);

    const dayOnly = seed().report({ window: "day", from: DAY2 });
    expect(dayOnly.totals.count).toBe(1);
    expect(dayOnly.byProvider.anthropic!.count).toBe(1);
  });

  it("prefers pre-computed / usage cost over the pricing resolver", () => {
    const store = new UsageStore({ pricing });
    store.record({
      ts: DAY1,
      principal: "x",
      provider: "openai",
      model: "gpt-x",
      usage: { inputTokens: 1_000_000, outputTokens: 0, costUsd: 42 },
    });
    expect(store.report().totals.costUsd).toBeCloseTo(42, 6);
  });
});

describe("run_summary ingestion", () => {
  it("attributes a run_summary row to a principal and uses its cost column", () => {
    const store = new UsageStore();
    const row: RunSummaryLike = {
      adapter_id: "mock",
      model: "mock-1",
      input_tokens: 100,
      output_tokens: 200,
      cost_usd: 1.25,
      created_at: DAY1,
    };
    store.recordRunSummary(row, { principal: "carol", role: "admin" });
    const report = store.report({ window: "day" });
    expect(report.totals.count).toBe(1);
    expect(report.totals.inputTokens).toBe(100);
    expect(report.totals.costUsd).toBeCloseTo(1.25, 6);
    expect(report.byPrincipal.carol!.count).toBe(1);
    expect(report.byRole.admin!.count).toBe(1);
    expect(report.byProvider.mock!.count).toBe(1);
  });
});

describe("export", () => {
  it("exports JSON that round-trips", () => {
    const report = seed().report({ window: "day" });
    const json = toJson(report);
    const parsed = JSON.parse(json);
    expect(parsed.window).toBe("day");
    expect(parsed.totals.count).toBe(3);
    expect(parsed.rows.length).toBe(report.rows.length);
  });

  it("exports CSV with a header and one line per row grain", () => {
    const report = seed().report({ window: "day" });
    const csv = toCsv(report);
    const lines = csv.trimEnd().split("\n");
    expect(lines[0]).toBe(
      "bucket,principal,role,provider,model,count,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,reasoning_tokens,cost_usd",
    );
    // 3 distinct (bucket,principal,role,provider,model) combos.
    expect(lines).toHaveLength(1 + 3);
    // Rows are sorted by bucket, provider, model — day1 openai first.
    expect(lines[1]!.startsWith("2026-01-01,")).toBe(true);
    // The anthropic/day2 row carries cost 9.000000.
    const day2 = lines.find((l) => l.includes("anthropic"));
    expect(day2).toBeDefined();
    expect(day2!.endsWith(",9.000000")).toBe(true);
  });

  it("quotes CSV cells containing separators", () => {
    const store = new UsageStore({ pricing });
    store.record({
      ts: DAY1,
      principal: "team, inc",
      provider: "openai",
      model: "gpt-x",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    const csv = toCsv(store.report());
    expect(csv).toContain('"team, inc"');
  });
});

describe("bucketOf", () => {
  it("labels day/week/month in UTC", () => {
    expect(bucketOf(DAY1, "day")).toBe("2026-01-01");
    expect(bucketOf(DAY1, "month")).toBe("2026-01");
    expect(bucketOf(DAY1, "week")).toBe("2026-W01");
  });
});
