/**
 * @nexuscode/rag — Retrieval-Augmented Generation subsystem (system-spec §16:
 * embeddings · chunking · vector databases · hybrid search · metadata filtering ·
 * reranking). Every piece is a pluggable seam:
 *
 *  - {@link Embedder}: deterministic offline {@link HashingEmbedder} for tests +
 *    real {@link createOllamaEmbedder}/{@link createOpenAIEmbedder} for production.
 *  - {@link chunkDocument}: overlapping, span-stamped chunks (citeable).
 *  - {@link VectorStore}: {@link InMemoryVectorStore} cosine index with JSON
 *    persistence; swap in a real ANN library behind the same interface.
 *  - {@link RagIndex}: `index(documents)` → chunk+embed+store, `query(text)` →
 *    hybrid (BM25 + cosine) ranked, cited results with a reranker seam.
 *  - {@link RagRetrievalSource}: additively bridges retrieval into the Context
 *    Engine's `retrieved` lane.
 */

// Embedders.
export {
  HashingEmbedder,
  createHashingEmbedder,
  createOllamaEmbedder,
  createOpenAIEmbedder,
} from "./embed/index.js";
export type {
  HashingEmbedderOptions,
  OllamaEmbedderOptions,
  OpenAIEmbedderOptions,
} from "./embed/index.js";

// Chunking.
export { chunkText, chunkDocument } from "./chunk.js";

// Vector store.
export { InMemoryVectorStore, matchFilter } from "./store.js";
export type { InMemoryVectorStoreOptions } from "./store.js";

// Keyword index.
export { Bm25Index } from "./bm25.js";
export type { Bm25Options } from "./bm25.js";

// Index API.
export { RagIndex, scoreReranker, DOC_HASH_META } from "./index-api.js";
export type { RagIndexOptions, IncrementalIndexResult } from "./index-api.js";

// Background + watch-mode indexing (system-spec §23).
export { BackgroundIndexer } from "./background.js";
export type { BackgroundIndexProgress, BackgroundIndexHandle } from "./background.js";
export { watchAndReindex } from "./watch.js";
export type { WatchReindexOptions, WatchReindexHandle } from "./watch.js";

// Context Engine bridge.
export { RagRetrievalSource } from "./context-source.js";
export type { RagRetrievalSourceOptions } from "./context-source.js";

// Secret scanning / redaction (no-secret-persisted invariant).
export { scanSecrets, redactSecrets, containsSecret, SECRET_PLACEHOLDER } from "./secret-scan.js";
export type { SecretScanResult } from "./secret-scan.js";

// Paths.
export { ragDataDir, ragStoreFile } from "./paths.js";

// Types.
export type {
  Chunk,
  ChunkOptions,
  Citation,
  Embedder,
  MetadataFilter,
  QueryOptions,
  QueryResult,
  RagDocument,
  Reranker,
  SearchMode,
  Span,
  VectorHit,
  VectorItem,
  VectorStore,
  VectorStoreSnapshot,
} from "./types.js";
