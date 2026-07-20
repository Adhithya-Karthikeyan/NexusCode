/**
 * Usage-analytics types (system-spec §25 Enterprise — Usage analytics / Cost
 * controls). Aggregate the frozen `Usage` struct + `computeCost` per principal /
 * role / provider / model over day / week / month windows.
 */

import type { Pricing, Usage } from "@nexuscode/shared";

/**
 * The principal a usage entry is attributed to when its SOURCE records no
 * principal at all — notably the SQLite `run_summary` table, whose columns
 * carry tokens/cost but no identity. Ingesting such rows under a real
 * principal id would INVENT attribution: it would tell whoever happens to be
 * running the report that every historical run was theirs, and let a report
 * scoped to one person silently include everyone else's spend. Rows land under
 * this sentinel instead, so a report is honestly un-attributed rather than
 * confidently wrong. Real attribution requires the producer to record the
 * acting principal alongside the run.
 */
export const UNATTRIBUTED_PRINCIPAL = "(unattributed)";

/** A single usage event fed into the store (one model call / run). */
export interface UsageEntry {
  /** Timestamp of the call (ms since epoch). */
  ts: number;
  /** Billing principal — the user/subject the cost is attributed to. */
  principal: string;
  /** RBAC role of the principal at call time, if known. */
  role?: string;
  /** Provider / adapter id (e.g. "openai", "anthropic", "mock"). */
  provider: string;
  /** Model id. */
  model: string;
  /** Normalized token usage. */
  usage: Usage;
  /**
   * Pre-computed cost. When omitted, cost is derived from `usage.costUsd`,
   * `usage.reportedCostUsd`, or `computeCost(usage, pricing)` if a price is
   * resolvable — otherwise 0.
   */
  costUsd?: number;
}

/** Time-bucket granularity for a report. */
export type TimeWindow = "day" | "week" | "month";

/** How totals are grouped in the breakdown. */
export type BreakdownKey = "principal" | "role" | "provider" | "model" | "bucket";

/** Resolve a `Pricing` for a provider/model, or undefined if unknown. */
export type PricingResolver = (provider: string, model: string) => Pricing | undefined;

/** Filter + shape of a report. */
export interface UsageQuery {
  /** Bucket granularity. Default "day". */
  window?: TimeWindow;
  principal?: string;
  role?: string;
  provider?: string;
  model?: string;
  /** Inclusive lower time bound (ms). */
  from?: number;
  /** Inclusive upper time bound (ms). */
  to?: number;
}

/** Aggregated totals for a group of entries. */
export interface UsageTotals {
  count: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  costUsd: number;
}

/** One fully-keyed aggregation row (the CSV grain). */
export interface UsageRow {
  bucket: string;
  principal: string;
  role: string;
  provider: string;
  model: string;
  totals: UsageTotals;
}

/** The full report: grand totals + per-dimension breakdowns + per-row grain. */
export interface UsageReport {
  window: TimeWindow;
  totals: UsageTotals;
  byPrincipal: Record<string, UsageTotals>;
  byRole: Record<string, UsageTotals>;
  byProvider: Record<string, UsageTotals>;
  byModel: Record<string, UsageTotals>;
  byBucket: Record<string, UsageTotals>;
  rows: UsageRow[];
}
