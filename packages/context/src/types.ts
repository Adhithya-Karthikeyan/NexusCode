/**
 * Public shapes for the Context Engine (system-spec §3).
 *
 * A {@link ContextSource} collects {@link ContextChunk}s; the {@link ContextEngine}
 * ranks, dedupes, compresses and packs them under a token budget into a
 * cache-stable `system` prefix plus volatile `messages`, and reports exactly
 * what was included/dropped via a {@link ContextReport}.
 */

import type { Message, Role } from "@nexuscode/shared";

/** Cache posture of a lane/source: `static` = cacheable prefix, `volatile` = tail. */
export type ContextKind = "static" | "volatile";

/**
 * Ordered lanes, from the most cache-stable prefix (index 0) to the most
 * volatile tail. STATIC lanes serialize into the `system` prefix so provider
 * prompt-caches hit; VOLATILE lanes render into `messages` and are trimmed
 * tail-first when over budget (feature-catalog invariant #3).
 */
export const CONTEXT_LANES = [
  "system",
  "tools",
  "memory",
  "conventions",
  "repo-map",
  "env",
  "retrieved",
  "git",
  "history",
  "terminal",
  "task",
] as const;

export type ContextLane = (typeof CONTEXT_LANES)[number];

/** Estimator seam. Default is char/4 (see {@link defaultEstimator}); swap for a real tokenizer. */
export type TokenEstimator = (text: string) => number;

/** Result of compressing an oversized chunk. */
export interface CompressResult {
  text: string;
  tokens: number;
  /** `true` when content was actually shortened (truncated/summarized). */
  summarized: boolean;
}

/** Compression seam. Default preserves head+tail and drops the middle. */
export type Compressor = (text: string, targetTokens: number, estimate: TokenEstimator) => CompressResult;

/** A single unit of assembled context produced by a source. */
export interface ContextChunk {
  /** Stable identity within a run; also the fallback dedupe key. */
  id: string;
  /** Which source emitted this chunk (stamped by the engine if omitted). */
  sourceId?: string;
  /** Placement lane — decides prefix vs tail ordering and trim priority. */
  lane: ContextLane;
  /** The payload text. */
  text: string;
  /** Role for `history`-lane chunks rendered as real messages. Defaults to `user`. */
  role?: Role;
  /** Precomputed token count; when absent the engine estimates from `text`. */
  tokens?: number;
  /** Relevance signal in [0,1]. Higher survives trimming longer. Default 0.5. */
  relevance?: number;
  /** Source priority (inherited from the source when omitted). Higher = more important. */
  priority?: number;
  /** Non-evictable: never trimmed and never compressed. */
  pinned?: boolean;
  /** Ordering key for chronological lanes (`history`, `task`). */
  createdAt?: number;
  /** Optional section label used when rendering. */
  title?: string;
  /** Free-form provenance for attribution. */
  meta?: Record<string, unknown>;
}

/** Context passed to every {@link ContextSource.collect}. */
export interface CollectContext {
  /** The user's current message/query (drives relevance for query-based sources). */
  userMessage: string;
  /** Working directory for filesystem/git sources. */
  cwd: string;
  /** Wall-clock used for deterministic ordering fallbacks. */
  now: number;
  /** The active token estimator. */
  estimate: TokenEstimator;
  /** Cooperative cancellation. */
  signal?: AbortSignal;
}

/**
 * A pluggable provider of context. `id` labels its chunks for attribution,
 * `priority` breaks ranking ties, and `kind` declares its cache posture.
 */
export interface ContextSource {
  readonly id: string;
  readonly priority: number;
  readonly kind: ContextKind;
  collect(ctx: CollectContext): Promise<ContextChunk[]>;
}

/** Options for {@link ContextEngine.assemble}. */
export interface AssembleOptions {
  /** Hard token budget for everything the engine assembles. */
  budgetTokens: number;
  /** Sources to collect from (collection runs in parallel). */
  sources: ContextSource[];
  /** The user's current message — always included, never trimmed. */
  userMessage: string;
  /** Working directory (default `process.cwd()`). */
  cwd?: string;
  /** Fixed clock (default `Date.now()`); pass for deterministic tests. */
  now?: number;
  /** Token estimator (default {@link defaultEstimator}). */
  estimate?: TokenEstimator;
  /** Compressor for oversized chunks (default {@link truncateMiddle}). */
  compress?: Compressor;
  /** Per-chunk token cap; oversized non-pinned chunks are compressed to it. */
  maxChunkTokens?: number;
  /** Max cache breakpoints reported over static lanes (default 4 — Anthropic's cap). */
  maxBreakpoints?: number;
  /** Weight applied to `priority` when scoring for dedupe/trim (default 1). */
  priorityWeight?: number;
  /** Cooperative cancellation forwarded to sources. */
  signal?: AbortSignal;
}

/** Why a chunk did not make the final assembly. */
export type DropReason = "budget" | "duplicate";

/** A chunk that survived into the final assembly. */
export interface IncludedChunk {
  id: string;
  sourceId: string;
  lane: ContextLane;
  kind: ContextKind;
  tokens: number;
  relevance: number;
  pinned: boolean;
}

/** A chunk that was excluded, with the reason. */
export interface DroppedChunk {
  id: string;
  sourceId: string;
  lane: ContextLane;
  tokens: number;
  reason: DropReason;
}

/** A chunk that was shrunk to fit. */
export interface CompressedChunk {
  id: string;
  sourceId: string;
  lane: ContextLane;
  fromTokens: number;
  toTokens: number;
}

/** Per-lane token accounting (segmented HUD bar). */
export interface LaneReport {
  lane: ContextLane;
  kind: ContextKind;
  tokens: number;
  count: number;
}

/** Per-source attribution. */
export interface SourceReport {
  id: string;
  kind: ContextKind;
  priority: number;
  collected: number;
  included: number;
  dropped: number;
  tokens: number;
}

/** A cache breakpoint offset at the end of a static lane. */
export interface Breakpoint {
  lane: ContextLane;
  tokenOffset: number;
}

/**
 * Full observability record for one assembly: honest real-vs-nominal token
 * counts, everything included/dropped/compressed, per-lane and per-source
 * accounting, and the cache breakpoints over the stable prefix.
 */
export interface ContextReport {
  budgetTokens: number;
  /** Total tokens of everything collected (pre-dedupe/compress/trim) + user message. */
  nominalTokens: number;
  /** Tokens actually assembled (post-everything) + user message. */
  realTokens: number;
  /** `true` when even after trimming the pinned floor still exceeds the budget. */
  overBudget: boolean;
  /** Tokens in the cacheable static prefix. */
  staticTokens: number;
  volatileTokens: number;
  userMessageTokens: number;
  /** Alias for `staticTokens` — the byte-stable, cache-eligible prefix size. */
  stablePrefixTokens: number;
  included: IncludedChunk[];
  dropped: DroppedChunk[];
  compressed: CompressedChunk[];
  lanes: LaneReport[];
  sources: SourceReport[];
  breakpoints: Breakpoint[];
}

/** What {@link ContextEngine.assemble} returns. */
export interface AssembleResult {
  /** Deterministically serialized static lanes — the cache-stable system prefix. */
  system: string;
  /** History turns plus a trailing user message bundling volatile context + the query. */
  messages: Message[];
  report: ContextReport;
}

export type { Message, Role };
