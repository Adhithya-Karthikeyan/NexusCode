/**
 * Cost controls (system-spec §25) — budgets per principal/role/org, fed from the
 * frozen `Usage` accounting, enforced as a pre-run gate and a post-run spend
 * record. The enforcement decision plugs into the existing router/hook seams
 * (a `pre-run` veto or a model downgrade); nothing here rewrites the router.
 */

import type { Pricing, Usage } from "@nexuscode/shared";

/** The identity axis a {@link Budget} is scoped to. */
export type BudgetScope = "principal" | "role" | "org";

/**
 * The accrual window a budget resets on:
 * - `"run"` — a single run (keyed by `runId`); spend accrues across the calls of
 *   one run and resets for the next run.
 * - `"day"` / `"month"` — a UTC calendar bucket; spend resets at the boundary.
 */
export type BudgetWindow = "run" | "day" | "month";

/** What to do when a run would push spend past the limit. */
export type OnExceed = "deny" | "downgrade";

/** A spend limit for one (scope, key) over one window. */
export interface Budget {
  /** Stable, unique id — also the {@link BudgetStore} accrual key. */
  id: string;
  scope: BudgetScope;
  /** The principal id / role name / org id this budget governs. */
  key: string;
  /** Hard ceiling in USD for the window. */
  limitUsd: number;
  window: BudgetWindow;
  /**
   * Fraction of `limitUsd` (0..1) at or above which {@link enforce} returns
   * `"warn"` (still allowed). Default 0.8. Set to 1 to disable the warning band.
   */
  warnThreshold?: number;
  /** Action on exceed. Default `"deny"`. */
  onExceed?: OnExceed;
  /**
   * Required when `onExceed === "downgrade"`: the cheaper model to reroute to,
   * as a `"provider/model"` pair or a bare model id the router understands.
   */
  downgradeTo?: string;
}

/** The principal/role/org an enforcement request is attributed to. */
export interface CostPrincipal {
  principal?: string;
  role?: string;
  org?: string;
  /** Required for `"run"`-window budgets; ignored by day/month windows. */
  runId?: string;
}

/** The verdict of a pre-run budget check. */
export type EnforceDecision = "allow" | "warn" | "deny" | "downgrade";

/** Per-budget status surfaced by {@link CostController.remaining}. */
export interface BudgetStatus {
  budgetId: string;
  scope: BudgetScope;
  key: string;
  window: BudgetWindow;
  limitUsd: number;
  spentUsd: number;
  /** `limitUsd - spentUsd`, floored at 0. */
  remainingUsd: number;
  /** Fraction of the limit already spent (0..1+). */
  utilization: number;
  /** True once spend has crossed the warn threshold. */
  warn: boolean;
}

/** The full result of {@link enforce} / {@link CostController.enforce}. */
export interface EnforceResult {
  decision: EnforceDecision;
  /** The governing budget that produced this decision (absent when `allow` with no budgets). */
  budgetId?: string;
  scope?: BudgetScope;
  limitUsd?: number;
  /** Spend already accrued in the window BEFORE this run. */
  spentUsd: number;
  /** The projected cost of this run that was tested. */
  projectedUsd: number;
  /** `limitUsd - spentUsd`, floored at 0 (undefined when no budget applied). */
  remainingUsd?: number;
  /** Present only when `decision === "downgrade"`: the model to reroute to. */
  downgradeTo?: string;
  /** Human-readable explanation for logs/audit. */
  reason: string;
  /** Every budget evaluated for this request (most-severe first). */
  evaluated: BudgetStatus[];
  /**
   * Present when `decision !== "deny"`: the projected spend was RESERVED
   * against every governing budget (closing the enforce()/record() TOCTOU
   * window). Pass to `CostController.record()`/`recordUsage()` to reconcile
   * it with the actual spend, or to `release()` to drop it without recording
   * (run cancelled/failed).
   */
  reservationId?: string;
}

/** A persisted spend record (fed from a completed run's {@link Usage}). */
export interface SpendRecord {
  budgetId: string;
  /** The window bucket the spend landed in (e.g. `"2026-07-19"`, a runId). */
  bucket: string;
  costUsd: number;
}

/**
 * Backing store for accrued spend. Keyed by (budgetId, window-bucket). An
 * in-memory and a JSON-file implementation ship in this package; both are
 * offline and deterministic under an injected clock.
 */
export interface BudgetStore {
  /** Accrued spend for a budget in a bucket (0 when the bucket is unseen/reset). */
  spent(budgetId: string, bucket: string): number;
  /** Add `costUsd` to (budgetId, bucket). */
  add(budgetId: string, bucket: string, costUsd: number): void;
  /** Drop all accrual (test/admin reset). */
  clear(): void;
  /** Snapshot every non-zero (budgetId, bucket) accrual. */
  snapshot(): SpendRecord[];
}

/** Recompute a projected/actual cost from a `Usage` record + its `Pricing`. */
export type { Pricing, Usage };
