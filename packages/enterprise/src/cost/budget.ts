/**
 * Window bucketing + cost projection helpers shared by the enforcer.
 */

import { computeCost } from "@nexuscode/shared";
import type { BudgetWindow, CostPrincipal, Pricing, Usage } from "./types.js";

/** A monotonic-ish wall clock in ms. Injected for deterministic tests. */
export type Clock = () => number;

/** Zero-pad an integer to two digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * The accrual bucket key for a budget window at time `atMs`:
 * - `day`   → `"YYYY-MM-DD"` (UTC)
 * - `month` → `"YYYY-MM"` (UTC)
 * - `run`   → the request's `runId` (empty string when absent; callers should
 *             always supply a `runId` for run-window budgets).
 */
export function windowBucket(window: BudgetWindow, atMs: number, principal: CostPrincipal): string {
  switch (window) {
    case "run":
      return principal.runId ?? "";
    case "day": {
      const d = new Date(atMs);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    }
    case "month": {
      const d = new Date(atMs);
      return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
    }
    default: {
      const _exhaustive: never = window;
      return _exhaustive;
    }
  }
}

/** Effective warn threshold fraction for a budget (default 0.8, clamped 0..1). */
export function warnThresholdOf(t: number | undefined): number {
  if (t === undefined) return 0.8;
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

/**
 * Project the USD cost of a run from an estimated {@link Usage} and its
 * {@link Pricing}. Thin wrapper over the frozen `computeCost` so the enforcer
 * and callers price a run the same way the accounting layer does.
 */
export function projectCost(usage: Usage, pricing: Pricing): number {
  return computeCost(usage, pricing);
}
