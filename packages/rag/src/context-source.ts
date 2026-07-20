/**
 * RagRetrievalSource — bridges the RAG index into the Context Engine (§3) as a
 * new {@link ContextSource}, additively (the engine itself is untouched). It runs
 * a query against a {@link RagIndex} and emits the top chunks into the volatile
 * `retrieved` lane, each carrying its citation in `meta` so downstream rendering/
 * attribution can point at the exact source + span. Query-dependent, hence
 * volatile — the cacheable static prefix stays byte-stable.
 */

import type { CollectContext, ContextChunk, ContextSource } from "@nexuscode/context";
import type { RagIndex } from "./index-api.js";
import type { MetadataFilter, QueryOptions } from "./types.js";

export interface RagRetrievalSourceOptions {
  /** The index to query. */
  index: RagIndex;
  /** Fixed query (default: `ctx.userMessage`). */
  query?: string;
  /** How many chunks to retrieve (default 5). */
  topK?: number;
  /** Metadata filter forwarded to the query. */
  filter?: MetadataFilter;
  /** Blend mode / alpha forwarded to the query. */
  mode?: QueryOptions["mode"];
  alpha?: number;
  /** Source id (default `"rag"`). */
  id?: string;
  /** Source priority (default 55, between memory and repo-map). */
  priority?: number;
}

export class RagRetrievalSource implements ContextSource {
  readonly id: string;
  readonly priority: number;
  readonly kind = "volatile" as const;

  constructor(private readonly opts: RagRetrievalSourceOptions) {
    this.id = opts.id ?? "rag";
    this.priority = opts.priority ?? 55;
  }

  async collect(ctx: CollectContext): Promise<ContextChunk[]> {
    const query = this.opts.query ?? ctx.userMessage;
    const queryOpts: QueryOptions = { topK: this.opts.topK ?? 5 };
    if (this.opts.filter !== undefined) queryOpts.filter = this.opts.filter;
    if (this.opts.mode !== undefined) queryOpts.mode = this.opts.mode;
    if (this.opts.alpha !== undefined) queryOpts.alpha = this.opts.alpha;

    const results = await this.opts.index.query(query, queryOpts);
    const n = results.length;
    return results.map((r, i) => {
      const chunk: ContextChunk = {
        id: `rag:${r.chunk.id}`,
        sourceId: this.id,
        lane: "retrieved",
        text: r.chunk.text,
        priority: this.priority,
        // Results are ranked best-first; map rank onto a descending relevance.
        relevance: n > 0 ? 1 - i / n : 0.5,
        title: r.citation.source ?? r.chunk.docId,
        meta: {
          docId: r.citation.docId,
          span: r.citation.span,
          score: r.score,
          ...(r.citation.source !== undefined ? { source: r.citation.source } : {}),
          ...(r.citation.lang !== undefined ? { lang: r.citation.lang } : {}),
        },
      };
      return chunk;
    });
  }
}
