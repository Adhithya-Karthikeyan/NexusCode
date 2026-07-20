/**
 * MemorySource — pulls the most relevant memory items via `@nexuscode/memory`'s
 * `recall(query, budget)`. Because recall is query-dependent it defaults to the
 * volatile `retrieved` lane (so the cacheable static prefix stays byte-stable);
 * pass `lane: "memory"` for durable, query-independent instructions.
 */

import type { MemoryStore } from "@nexuscode/memory";
import type { CollectContext, ContextChunk, ContextLane, ContextSource } from "../types.js";

export interface MemorySourceOptions {
  store: MemoryStore;
  /** Recall query (default: `ctx.userMessage`). */
  query?: string;
  /** Token budget handed to `recall` (default 500). */
  budgetTokens?: number;
  /** Lane to place recalled items in (default `retrieved`). */
  lane?: ContextLane;
  priority?: number;
}

export class MemorySource implements ContextSource {
  readonly id = "memory";
  readonly kind: ContextSource["kind"];
  readonly priority: number;
  private readonly lane: ContextLane;

  constructor(private readonly opts: MemorySourceOptions) {
    this.priority = opts.priority ?? 60;
    this.lane = opts.lane ?? "retrieved";
    this.kind = this.lane === "memory" ? "static" : "volatile";
  }

  async collect(ctx: CollectContext): Promise<ContextChunk[]> {
    const query = this.opts.query ?? ctx.userMessage;
    const budget = this.opts.budgetTokens ?? 500;
    const items = this.opts.store.recall(query, budget);
    const n = items.length;
    return items.map((item, i) => ({
      id: `memory:${item.id}`,
      sourceId: this.id,
      lane: this.lane,
      text: item.text,
      priority: this.priority,
      // Recall returns most-relevant first; map rank onto a descending signal.
      relevance: n > 0 ? 1 - i / n : 0.5,
      title: `${item.tier}/${item.kind}`,
      meta: { tier: item.tier, kind: item.kind, ...(item.source ? { source: item.source } : {}) },
    }));
  }
}
