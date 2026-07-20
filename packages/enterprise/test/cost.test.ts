/**
 * Cost-control tests (system-spec §25): a budget denies an over-limit run; a
 * downgrade policy reroutes to a cheaper model; spend accrues across runs within
 * a window and resets across windows; the warn threshold fires; remaining budget
 * is exposed; the most-restrictive of several governing budgets wins; spend is
 * fed from the frozen Usage + computeCost; and a file store persists across a
 * restart. Offline, deterministic under an injected clock.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  CostController,
  FileBudgetStore,
  InMemoryBudgetStore,
  applyDecisionToRoute,
  costPreRunHook,
  costPostRunHook,
  parseDowngradeTarget,
  type Budget,
  type CostPrincipal,
} from "../src/cost/index.js";
import type { Pricing, Usage } from "@nexuscode/shared";

// A fixed clock: two timestamps in different UTC days / months.
const DAY1 = Date.UTC(2026, 6, 19, 10, 0, 0); // 2026-07-19
const DAY2 = Date.UTC(2026, 6, 20, 10, 0, 0); // 2026-07-20
const MONTH2 = Date.UTC(2026, 7, 1, 10, 0, 0); // 2026-08-01

const ALICE: CostPrincipal = { principal: "alice", role: "dev", org: "acme", runId: "run-1" };

describe("enforce — deny on over-limit", () => {
  it("denies a run whose projected cost would exceed the day budget", () => {
    const budget: Budget = { id: "b-day", scope: "principal", key: "alice", limitUsd: 1.0, window: "day" };
    const c = new CostController([budget], { store: new InMemoryBudgetStore() });

    // First run projected under limit → allow.
    const r1 = c.enforce(ALICE, 0.4, DAY1);
    expect(r1.decision).toBe("allow");
    c.record(ALICE, 0.4, DAY1);

    // Now spent 0.4; a 0.7 run would total 1.1 > 1.0 → deny.
    const r2 = c.enforce(ALICE, 0.7, DAY1);
    expect(r2.decision).toBe("deny");
    expect(r2.budgetId).toBe("b-day");
    expect(r2.spentUsd).toBeCloseTo(0.4, 6);
    expect(r2.remainingUsd).toBeCloseTo(0.6, 6);
    expect(r2.reason).toMatch(/exceed/i);
  });
});

describe("enforce — downgrade to a cheaper model", () => {
  it("returns a downgrade decision + target when onExceed=downgrade", () => {
    const budget: Budget = {
      id: "b-dg",
      scope: "org",
      key: "acme",
      limitUsd: 0.5,
      window: "day",
      onExceed: "downgrade",
      downgradeTo: "openai/gpt-4o-mini",
    };
    const c = new CostController([budget]);
    const r = c.enforce(ALICE, 5.0, DAY1); // way over 0.5
    expect(r.decision).toBe("downgrade");
    expect(r.downgradeTo).toBe("openai/gpt-4o-mini");

    // The route helper reroutes to the single cheaper target.
    const rerouted = applyDecisionToRoute(r, [
      { providerId: "anthropic", modelId: "claude-opus" },
      { providerId: "anthropic", modelId: "claude-sonnet" },
    ]);
    expect(rerouted).toEqual([{ providerId: "openai", modelId: "gpt-4o-mini" }]);
  });

  it("falls back to deny (fail closed) when downgrade is misconfigured (no target)", () => {
    const budget: Budget = { id: "b-bad", scope: "principal", key: "alice", limitUsd: 0.5, window: "day", onExceed: "downgrade" };
    const c = new CostController([budget]);
    const r = c.enforce(ALICE, 5.0, DAY1);
    expect(r.decision).toBe("deny");
  });

  it("parseDowngradeTarget splits provider/model and bare model", () => {
    expect(parseDowngradeTarget("openai/gpt-4o-mini", "anthropic")).toEqual({ providerId: "openai", modelId: "gpt-4o-mini" });
    expect(parseDowngradeTarget("haiku", "anthropic")).toEqual({ providerId: "anthropic", modelId: "haiku" });
  });
});

describe("spend accrues within a window and resets across windows", () => {
  it("day window: accrues across runs on the same day, resets the next day", () => {
    const budget: Budget = { id: "b-day", scope: "principal", key: "alice", limitUsd: 1.0, window: "day" };
    const store = new InMemoryBudgetStore();
    const c = new CostController([budget], { store });

    c.record(ALICE, 0.3, DAY1);
    c.record(ALICE, 0.3, DAY1);
    expect(c.remaining(ALICE, DAY1)[0]!.spentUsd).toBeCloseTo(0.6, 6);

    // Same day, a 0.5 run would total 1.1 → deny.
    expect(c.enforce(ALICE, 0.5, DAY1).decision).toBe("deny");

    // Next day → fresh window, spend resets to 0 → allow.
    expect(c.remaining(ALICE, DAY2)[0]!.spentUsd).toBe(0);
    expect(c.enforce(ALICE, 0.5, DAY2).decision).toBe("allow");
  });

  it("month window resets across months", () => {
    const budget: Budget = { id: "b-mo", scope: "org", key: "acme", limitUsd: 2.0, window: "month" };
    const c = new CostController([budget]);
    c.record(ALICE, 1.8, DAY1); // July
    expect(c.enforce(ALICE, 0.5, DAY2).decision).toBe("deny"); // still July, 1.8+0.5>2.0
    expect(c.enforce(ALICE, 0.5, MONTH2).decision).toBe("allow"); // August fresh
  });

  it("run window is keyed by runId — a new run starts fresh", () => {
    const budget: Budget = { id: "b-run", scope: "principal", key: "alice", limitUsd: 1.0, window: "run" };
    const c = new CostController([budget]);
    const run1: CostPrincipal = { principal: "alice", runId: "run-1" };
    const run2: CostPrincipal = { principal: "alice", runId: "run-2" };
    c.record(run1, 0.9, DAY1);
    expect(c.enforce(run1, 0.2, DAY1).decision).toBe("deny"); // 0.9+0.2>1.0 within run-1
    expect(c.enforce(run2, 0.2, DAY1).decision).toBe("allow"); // run-2 is a fresh bucket
  });
});

describe("warn threshold", () => {
  it("fires warn when projected total crosses the threshold but stays under the limit", () => {
    const budget: Budget = { id: "b-warn", scope: "principal", key: "alice", limitUsd: 1.0, window: "day", warnThreshold: 0.8 };
    const c = new CostController([budget]);
    // Each check below previews a DIFFERENT hypothetical run at the same
    // instant, so release the reservation after each rather than letting them
    // stack — a real concurrent SECOND run (not released) is exactly what the
    // reservation is meant to deny; see "budget reservation (TOCTOU)" below.
    const r1 = c.enforce(ALICE, 0.5, DAY1);
    expect(r1.decision).toBe("allow"); // 50% < 80%
    if (r1.reservationId) c.release(r1.reservationId);

    const r2 = c.enforce(ALICE, 0.85, DAY1);
    expect(r2.decision).toBe("warn"); // 85% ≥ 80%, < 100%
    if (r2.reservationId) c.release(r2.reservationId);

    expect(c.enforce(ALICE, 1.01, DAY1).decision).toBe("deny"); // over
  });

  it("remaining() surfaces the warn flag once accrued spend crosses the threshold", () => {
    const budget: Budget = { id: "b-warn", scope: "principal", key: "alice", limitUsd: 1.0, window: "day", warnThreshold: 0.8 };
    const c = new CostController([budget]);
    c.record(ALICE, 0.85, DAY1);
    const status = c.remaining(ALICE, DAY1)[0]!;
    expect(status.warn).toBe(true);
    expect(status.remainingUsd).toBeCloseTo(0.15, 6);
    expect(status.utilization).toBeCloseTo(0.85, 6);
  });
});

describe("most-restrictive across principal/role/org budgets", () => {
  it("an org ceiling denies even when the personal budget would allow", () => {
    const personal: Budget = { id: "b-p", scope: "principal", key: "alice", limitUsd: 100, window: "day" };
    const org: Budget = { id: "b-o", scope: "org", key: "acme", limitUsd: 1.0, window: "day" };
    const c = new CostController([personal, org]);
    c.record(ALICE, 0.9, DAY1); // hits both budgets' buckets
    const r = c.enforce(ALICE, 0.5, DAY1); // personal ok (0.9+0.5<100) but org 0.9+0.5>1.0
    expect(r.decision).toBe("deny");
    expect(r.scope).toBe("org");
    expect(r.evaluated).toHaveLength(2);
  });
});

describe("budget reservation (TOCTOU) — enforce()/record() are not atomic", () => {
  it("two concurrent enforce() calls that together would overshoot: the second is denied", () => {
    const budget: Budget = { id: "b-conc", scope: "principal", key: "alice", limitUsd: 1.0, window: "day" };
    const c = new CostController([budget]);

    // First "concurrent" request: projects $0.6, fits alone under the $1.0
    // limit → allow, and RESERVES $0.6 against the bucket.
    const r1 = c.enforce(ALICE, 0.6, DAY1);
    expect(r1.decision).toBe("allow");
    expect(r1.reservationId).toBeDefined();

    // Second request arrives before the first records or releases anything —
    // without the fix it would see the same pre-accrual $0 spent and also
    // pass (0.6 + 0.6 = 1.2 > 1.0 would overshoot). The reservation makes the
    // SECOND enforce() see $0.6 already held and deny.
    const r2 = c.enforce(ALICE, 0.6, DAY1);
    expect(r2.decision).toBe("deny");
    expect(r2.evaluated[0]!.remainingUsd).toBeCloseTo(0.4, 6);
  });

  it("a released reservation frees the budget back up", () => {
    const budget: Budget = { id: "b-rel", scope: "principal", key: "alice", limitUsd: 1.0, window: "day" };
    const c = new CostController([budget]);

    const r1 = c.enforce(ALICE, 0.6, DAY1);
    expect(r1.decision).toBe("allow");
    expect(c.enforce(ALICE, 0.6, DAY1).decision).toBe("deny"); // still held

    // The run behind r1 was cancelled/failed — release without recording spend.
    c.release(r1.reservationId!);
    const r3 = c.enforce(ALICE, 0.6, DAY1);
    expect(r3.decision).toBe("allow");
  });

  it("record() with the enforce()-returned reservationId reconciles exactly", () => {
    // warnThreshold:1 disables the warn band so this test stays focused on
    // reservation accounting rather than the (separately-tested) warn logic.
    const budget: Budget = { id: "b-rec", scope: "principal", key: "alice", limitUsd: 1.0, window: "day", warnThreshold: 1 };
    const c = new CostController([budget]);

    const r1 = c.enforce(ALICE, 0.6, DAY1);
    expect(r1.decision).toBe("allow");
    // Actual cost differs from the projection — record() still fully retires
    // the reservation (not just the recorded amount) when given its id.
    c.record(ALICE, 0.3, DAY1, r1.reservationId);

    const status = c.remaining(ALICE, DAY1)[0]!;
    expect(status.spentUsd).toBeCloseTo(0.3, 6);
    // No leftover reservation: a further $0.6 request still fits ($0.3+$0.6<$1.0).
    expect(c.enforce(ALICE, 0.6, DAY1).decision).toBe("allow");
  });
});

describe("spend fed from Usage + computeCost", () => {
  it("recordUsage prices a Usage record and accrues it", () => {
    const budget: Budget = { id: "b-u", scope: "principal", key: "alice", limitUsd: 1.0, window: "day" };
    const c = new CostController([budget]);
    const pricing: Pricing = { inputPerMTok: 3, outputPerMTok: 15 };
    const usage: Usage = { inputTokens: 100_000, outputTokens: 20_000 }; // 0.3 + 0.3 = 0.6
    const cost = c.recordUsage(ALICE, usage, pricing, DAY1);
    expect(cost).toBeCloseTo(0.6, 6);
    expect(c.remaining(ALICE, DAY1)[0]!.spentUsd).toBeCloseTo(0.6, 6);
  });

  it("no governing budget → allow (or deny under denyIfNoBudget fail-closed)", () => {
    const open = new CostController([]);
    expect(open.enforce({ principal: "nobody" }, 999, DAY1).decision).toBe("allow");
    const closed = new CostController([], { denyIfNoBudget: true });
    expect(closed.enforce({ principal: "nobody" }, 0.01, DAY1).decision).toBe("deny");
  });
});

describe("FileBudgetStore — spend survives a restart within a window", () => {
  const dir = mkdtempSync(join(tmpdir(), "nexus-budget-"));
  const path = join(dir, "spend.json");
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("persists accrual to disk and rehydrates it", () => {
    const budget: Budget = { id: "b-day", scope: "principal", key: "alice", limitUsd: 1.0, window: "day" };

    const c1 = new CostController([budget], { store: new FileBudgetStore(path) });
    c1.record(ALICE, 0.7, DAY1);

    // "Restart": a new controller over a fresh store pointed at the same file.
    const c2 = new CostController([budget], { store: new FileBudgetStore(path) });
    expect(c2.remaining(ALICE, DAY1)[0]!.spentUsd).toBeCloseTo(0.7, 6);
    expect(c2.enforce(ALICE, 0.5, DAY1).decision).toBe("deny"); // 0.7+0.5>1.0 survived restart
  });
});

describe("hook-bus integration (pre-run veto / post-run record)", () => {
  it("costPreRunHook blocks on deny and rewrites the model on downgrade", () => {
    const denyBudget: Budget = { id: "b-deny", scope: "principal", key: "alice", limitUsd: 0.1, window: "day" };
    const c = new CostController([denyBudget]);
    const hook = costPreRunHook(c, () => ({ principal: ALICE, projectedUsd: 1.0 }));
    const verdict = hook({ adapterId: "openai", model: "gpt-4o", runId: "run-1" });
    expect(verdict).toEqual({ block: true, reason: expect.stringMatching(/exceed/i) });

    const dgBudget: Budget = { id: "b-dg2", scope: "principal", key: "alice", limitUsd: 0.1, window: "day", onExceed: "downgrade", downgradeTo: "openai/gpt-4o-mini" };
    const c2 = new CostController([dgBudget]);
    const hook2 = costPreRunHook(c2, () => ({ principal: ALICE, projectedUsd: 1.0 }));
    const v2 = hook2({ adapterId: "openai", model: "gpt-4o", runId: "run-1" });
    expect(v2?.modify?.model).toBe("gpt-4o-mini");
  });

  it("costPostRunHook accrues the completed run's usage cost", () => {
    const budget: Budget = { id: "b-post", scope: "principal", key: "alice", limitUsd: 1.0, window: "day" };
    const c = new CostController([budget]);
    const post = costPostRunHook(c, () => ALICE);
    post({ runId: "run-1", usage: { costUsd: 0.42 } });
    expect(c.remaining(ALICE)[0]!.spentUsd).toBeCloseTo(0.42, 6);
  });
});
