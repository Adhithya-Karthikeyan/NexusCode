/**
 * Memory types (system-spec §4). Three tiers behind one API:
 *  - `short`     — conversation turns + a scratchpad (session-scoped, in-memory).
 *  - `long`      — user preferences, coding style, project conventions (persisted).
 *  - `knowledge` — documents, architecture, decisions (persisted).
 *
 * Every item is stamped (`createdAt`/`updatedAt`) so the store is auditable, and
 * every mutation restamps `updatedAt`.
 */

/** Which tier an item lives in. */
export type MemoryTier = "short" | "long" | "knowledge";

/**
 * Semantic kind of a memory item. The listed values are the ones NexusCode
 * emits today; the open `(string & {})` arm keeps the field extensible without
 * breaking exhaustiveness on the known set.
 */
export type MemoryKind =
  | "conversation"
  | "scratchpad"
  | "preference"
  | "coding-style"
  | "convention"
  | "command"
  | "document"
  | "architecture"
  | "decision"
  | "instruction"
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {});

/** A single unit of memory. Persisted verbatim for the durable tiers. */
export interface MemoryItem {
  /** Stable identifier. Deterministic for ingested files; random otherwise. */
  id: string;
  tier: MemoryTier;
  kind: MemoryKind;
  /** The payload — free text (an instruction file body, a preference, a note). */
  text: string;
  /** Optional lexical tags used for filtering and recall boosting. */
  tags?: string[];
  /** Provenance: a file path, a URL, a session id, etc. */
  source?: string;
  /** Epoch millis at creation. Never changes after the first write. */
  createdAt: number;
  /** Epoch millis of the last mutation. Restamped on every update. */
  updatedAt: number;
}

/** Fields accepted by {@link MemoryStore.put}. */
export interface MemoryPut {
  tier: MemoryTier;
  kind: MemoryKind;
  text: string;
  tags?: string[];
  source?: string;
  /** Provide to upsert a known id (idempotent ingestion); omit for a fresh id. */
  id?: string;
}

/** Mutable fields accepted by {@link MemoryStore.update}. */
export interface MemoryPatch {
  kind?: MemoryKind;
  text?: string;
  tags?: string[];
  source?: string;
}

/** Filter for {@link MemoryStore.list}. All present clauses must match (AND). */
export interface MemoryFilter {
  tier?: MemoryTier;
  kind?: MemoryKind;
  /** Item must carry this tag. */
  tag?: string;
  source?: string;
}

/** Options for {@link MemoryStore.search}. */
export interface SearchOptions {
  /** Restrict to a single tier. */
  tier?: MemoryTier;
  kind?: MemoryKind;
  /** Cap the number of hits returned (default: all non-zero-scoring items). */
  limit?: number;
}

/** A scored search hit. Exposed so ranking is inspectable/auditable. */
export interface SearchHit {
  item: MemoryItem;
  score: number;
}

/**
 * Relevance scorer. The default is lexical (see {@link lexicalScore}); swapping
 * in an embedding-backed implementation is the seam for future semantic recall.
 * A score of `0` (or below) means "not relevant" and is excluded from results.
 */
export type ScoreFn = (query: string, item: MemoryItem) => number;
