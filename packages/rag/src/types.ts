/**
 * Public shapes for @nexuscode/rag (system-spec §16: embeddings · chunking ·
 * vector databases · hybrid search · metadata filtering · reranking).
 *
 * The subsystem is a pipeline of pluggable seams:
 *   documents → {@link Chunker} → {@link Embedder} → {@link VectorStore}
 * and, at query time, a hybrid of keyword + semantic search that returns
 * {@link QueryResult}s each carrying a {@link Citation} (source + span) so an
 * answer can attribute exactly where its evidence came from.
 */

// ── Embeddings ────────────────────────────────────────────────────────────────

/**
 * Turns text into fixed-dimension vectors. The default local implementation
 * ({@link HashingEmbedder}) is deterministic and network-free (for offline use
 * and tests); {@link createOllamaEmbedder} / {@link createOpenAIEmbedder} are the
 * real, remote seams that are never exercised by the test suite.
 */
export interface Embedder {
  /** Stable identifier (used to tag the store so mismatched vectors are caught). */
  readonly id: string;
  /** Dimensionality of every vector this embedder produces. */
  readonly dims: number;
  /** Embed a batch of texts; result[i] corresponds to texts[i]. */
  embed(texts: string[]): Promise<number[][]>;
}

// ── Chunking ──────────────────────────────────────────────────────────────────

/** A document handed to {@link RagIndex.index}. */
export interface RagDocument {
  /** Stable document id; chunk ids are derived from it. */
  id: string;
  /** Full document text. */
  text: string;
  /** Provenance (file path, URL, …) copied onto every chunk for citation. */
  source?: string;
  /** Language tag (e.g. `"ts"`, `"md"`), copied onto every chunk. */
  lang?: string;
  /** Free-form metadata copied onto every chunk (available to filters). */
  meta?: Record<string, unknown>;
}

/** A half-open `[start, end)` character range within the source document. */
export interface Span {
  start: number;
  end: number;
}

/** One retrievable unit: a slice of a document plus everything needed to cite it. */
export interface Chunk {
  /** Stable id, `${docId}#${index}`. */
  id: string;
  /** Owning document id. */
  docId: string;
  /** Ordinal of this chunk within its document (0-based). */
  index: number;
  /** The chunk text. */
  text: string;
  /** Character span of `text` within the original document. */
  span: Span;
  source?: string;
  lang?: string;
  meta?: Record<string, unknown>;
}

/** Options for {@link chunkText} / {@link chunkDocument}. */
export interface ChunkOptions {
  /** Target chunk size in characters (default 800). */
  chunkSize?: number;
  /** Character overlap carried between consecutive chunks (default 100). */
  overlap?: number;
  /**
   * When true (default) the splitter backtracks to the nearest whitespace so
   * chunks don't cut through a word/token; set false for hard fixed windows.
   */
  respectWordBoundaries?: boolean;
}

// ── Vector store ──────────────────────────────────────────────────────────────

/** An item to insert into a {@link VectorStore}: an id, its vector, and its chunk. */
export interface VectorItem {
  id: string;
  vector: number[];
  chunk: Chunk;
}

/** A single similarity hit from a {@link VectorStore}. */
export interface VectorHit {
  id: string;
  /** Cosine similarity in `[-1, 1]` (`[0, 1]` for the default embedder). */
  score: number;
  chunk: Chunk;
}

/**
 * Metadata filter applied before scoring. All present clauses must match (AND).
 * Equality clauses compare the chunk's field; `meta` compares nested keys; the
 * `predicate` seam allows arbitrary custom matching.
 */
export interface MetadataFilter {
  docId?: string;
  source?: string;
  lang?: string;
  /** Each key must equal the chunk's `meta[key]` (deep-equal by JSON). */
  meta?: Record<string, unknown>;
  predicate?: (chunk: Chunk) => boolean;
}

/** Serialized form of a {@link VectorStore} (JSON persistence). */
export interface VectorStoreSnapshot {
  version: 1;
  embedderId: string;
  dims: number;
  items: VectorItem[];
}

/**
 * Pluggable vector index. The default {@link InMemoryVectorStore} does exact
 * cosine search; a real ANN library can slot behind the same interface later.
 */
export interface VectorStore {
  readonly dims: number;
  readonly size: number;
  /** Insert (or replace by id) items. Throws on a vector/dimension mismatch. */
  add(items: VectorItem[]): void;
  /** Top-`topK` nearest chunks to `query`, optionally metadata-filtered. */
  search(query: number[], topK: number, filter?: MetadataFilter): VectorHit[];
  /** Delete by id; returns how many were removed. */
  delete(ids: string[]): number;
  /** Delete every chunk of a document; returns how many were removed. */
  deleteByDoc(docId: string): number;
  /** Remove everything. */
  clear(): void;
  /** Every stored chunk (used to rebuild the keyword index). */
  chunks(): Chunk[];
  /** In-memory snapshot for persistence. */
  toJSON(): VectorStoreSnapshot;
  /** Atomically write the snapshot to `file` (default: the data-dir store file). */
  save(file?: string): string;
  /** Load a snapshot from `file` (default: the data-dir store file); no-op if absent. */
  load(file?: string): void;
}

// ── Query & citations ─────────────────────────────────────────────────────────

/** How a query blends signals. */
export type SearchMode = "hybrid" | "semantic" | "keyword";

/** A reranker seam: reorder (or rescore) results after the initial blend. */
export type Reranker = (query: string, results: QueryResult[]) => QueryResult[];

/** Options for {@link RagIndex.query}. */
export interface QueryOptions {
  /** Max results to return (default 5). */
  topK?: number;
  /** Metadata filter applied to candidates before scoring. */
  filter?: MetadataFilter;
  /** Blend mode (default `"hybrid"`). */
  mode?: SearchMode;
  /**
   * Hybrid blend weight in `[0, 1]`: `score = alpha·semantic + (1-alpha)·keyword`
   * over min-max-normalized signals. Default 0.5. Ignored for non-hybrid modes.
   */
  alpha?: number;
  /** Reranker override for this query (default: the index's, else score order). */
  reranker?: Reranker;
}

/** Where a result came from — enough to render an inline citation. */
export interface Citation {
  docId: string;
  source?: string;
  lang?: string;
  span: Span;
}

/** A ranked, cited search result. */
export interface QueryResult {
  chunk: Chunk;
  /** Final blended score used for ranking. */
  score: number;
  /** Raw cosine similarity (semantic signal). */
  semanticScore: number;
  /** Raw BM25 score (keyword signal). */
  keywordScore: number;
  /** Provenance for attribution. */
  citation: Citation;
}
