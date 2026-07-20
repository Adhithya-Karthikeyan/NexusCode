/**
 * RepoMapSource — exposes the file-intelligence repo map as a Context Engine
 * {@link ContextSource} on the static `repo-map` lane. This is the structural
 * context source (system-spec §3/§11): it EXTENDS the Context Engine via the
 * existing seam rather than modifying it. Its output is deterministic and its
 * chunk id is stable, so it stays inside the cacheable static prefix.
 */

import type { CollectContext, ContextChunk, ContextSource } from "@nexuscode/context";
import { repoMap, type RepoMapOptions } from "./repomap.js";

export interface RepoMapSourceOptions extends RepoMapOptions {
  /** Root to map (default: `ctx.cwd`). */
  root?: string;
  /** Source priority (default 72 — just above raw project files). */
  priority?: number;
}

/** A static context source that emits an aider-style, token-budgeted repo map. */
export class RepoMapSource implements ContextSource {
  readonly id = "repo-map";
  readonly kind = "static" as const;
  readonly priority: number;

  constructor(private readonly opts: RepoMapSourceOptions = {}) {
    this.priority = opts.priority ?? 72;
  }

  async collect(ctx: CollectContext): Promise<ContextChunk[]> {
    const root = this.opts.root ?? ctx.cwd;
    // Give the map ~15% of nothing here — the engine budgets globally; we cap at
    // a sane default and let the engine compress/trim if needed.
    const budgetTokens = this.opts.budgetTokens ?? 1024;
    const map = await repoMap(root, {
      ...this.opts,
      budgetTokens,
      estimate: this.opts.estimate ?? ctx.estimate,
    });
    if (map.text.length === 0) return [];
    return [
      {
        id: "repo-map:structure",
        sourceId: this.id,
        lane: "repo-map",
        text: map.text,
        priority: this.priority,
        relevance: 0.6,
        title: "Repo Map",
        meta: { files: map.files.length, symbols: map.ranked.length, truncated: map.truncated },
      },
    ];
  }
}
