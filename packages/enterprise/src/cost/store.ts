/**
 * Spend stores. Accrual is keyed by `budgetId` then window `bucket`, so window
 * resets are implicit: a new day/month/run produces a new bucket key whose
 * accrual starts at 0 — no scheduled sweep is needed.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { BudgetStore, SpendRecord } from "./types.js";

/** In-memory spend store. The default; deterministic and dependency-free. */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly byBudget = new Map<string, Map<string, number>>();

  spent(budgetId: string, bucket: string): number {
    return this.byBudget.get(budgetId)?.get(bucket) ?? 0;
  }

  add(budgetId: string, bucket: string, costUsd: number): void {
    if (!(costUsd > 0)) return; // ignore zero/negative/NaN
    let buckets = this.byBudget.get(budgetId);
    if (!buckets) {
      buckets = new Map<string, number>();
      this.byBudget.set(budgetId, buckets);
    }
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + costUsd);
  }

  clear(): void {
    this.byBudget.clear();
  }

  snapshot(): SpendRecord[] {
    const out: SpendRecord[] = [];
    for (const [budgetId, buckets] of this.byBudget) {
      for (const [bucket, costUsd] of buckets) {
        if (costUsd !== 0) out.push({ budgetId, bucket, costUsd });
      }
    }
    return out;
  }

  /** Rehydrate accrual from a snapshot (used by the file store on load). */
  load(records: readonly SpendRecord[]): void {
    for (const r of records) this.add(r.budgetId, r.bucket, r.costUsd);
  }
}

/**
 * A JSON-file spend store: an {@link InMemoryBudgetStore} that persists its
 * snapshot to `path` after every mutation and rehydrates from it on
 * construction. Offline and temp-file-friendly for verifying that spend
 * survives a process restart within a window.
 */
export class FileBudgetStore implements BudgetStore {
  private readonly mem = new InMemoryBudgetStore();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf8");
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) this.mem.load(parsed as SpendRecord[]);
      } catch {
        // Corrupt/partial file → start empty rather than crash. The next flush
        // rewrites a well-formed snapshot.
      }
    }
  }

  spent(budgetId: string, bucket: string): number {
    return this.mem.spent(budgetId, bucket);
  }

  add(budgetId: string, bucket: string, costUsd: number): void {
    this.mem.add(budgetId, bucket, costUsd);
    this.flush();
  }

  clear(): void {
    this.mem.clear();
    this.flush();
  }

  snapshot(): SpendRecord[] {
    return this.mem.snapshot();
  }

  private flush(): void {
    writeFileSync(this.path, JSON.stringify(this.mem.snapshot()), "utf8");
  }
}
