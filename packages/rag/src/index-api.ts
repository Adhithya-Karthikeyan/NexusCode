/**
 * RagIndex — the top-level RAG API (system-spec §16). Wires the pipeline:
 *   index(documents) → chunk → embed → store  (+ keep a BM25 index in sync)
 *   query(text, opts) → embed query → hybrid blend of cosine + BM25 → rerank
 * Every result carries a {@link Citation} (source + span) so answers can attribute
 * their evidence. Semantic, keyword, and hybrid modes are all first-class; the
 * hybrid blend is min-max normalized so the two signals are comparable.
 *
 * Persistence delegates to the {@link VectorStore} (JSON, data-dir); on load the
 * keyword index is rebuilt from the restored chunks so both halves stay in sync.
 */

import { createHash } from "node:crypto";
import { Bm25Index, type Bm25Options } from "./bm25.js";
import { chunkDocument } from "./chunk.js";
import { redactSecrets } from "./secret-scan.js";
import { InMemoryVectorStore } from "./store.js";
import { minMaxNormalize } from "./text.js";
import type {
  Chunk,
  ChunkOptions,
  Citation,
  Embedder,
  QueryOptions,
  QueryResult,
  RagDocument,
  Reranker,
  SearchMode,
  VectorStore,
} from "./types.js";

/** Default reranker: stable sort by blended score descending (id tiebreak). */
export const scoreReranker: Reranker = (_query, results) =>
  [...results].sort(
    (a, b) => b.score - a.score || (a.chunk.id < b.chunk.id ? -1 : a.chunk.id > b.chunk.id ? 1 : 0),
  );

/**
 * Reserved chunk-meta key holding the SHA-256 of the source document's text,
 * stamped by {@link RagIndex.incrementalIndex} so a later incremental run can
 * tell whether a document actually changed. Double-underscored so it never
 * collides with a caller's metadata filter.
 */
export const DOC_HASH_META = "__contentHash";

/** Outcome of an {@link RagIndex.incrementalIndex} pass. */
export interface IncrementalIndexResult {
  /** Document ids that were (re)chunked + embedded because they were new or changed. */
  indexed: string[];
  /** Document ids skipped because their content hash matched the stored one (no embed). */
  skipped: string[];
  /** Document ids removed because they were absent from the input and `prune` was set. */
  removed: string[];
}

export interface RagIndexOptions {
  /** The embedder (required). */
  embedder: Embedder;
  /** Vector store (default: an {@link InMemoryVectorStore} sized to the embedder). */
  store?: VectorStore;
  /** Chunking options applied to every indexed document. */
  chunk?: ChunkOptions;
  /** BM25 tuning. */
  bm25?: Bm25Options;
  /** Default reranker (default: {@link scoreReranker}). */
  reranker?: Reranker;
  /** Default persistence file for `save`/`load`. */
  file?: string;
  /**
   * Redact detected secrets from chunk text before it is embedded, stored, or
   * persisted (default `true`). This enforces the "no secret persisted into the
   * index/cache" invariant and prevents a remote embedder from receiving raw
   * credentials over the network. Set `false` only for trusted, secret-free
   * corpora where redaction is provably unnecessary.
   */
  redactSecrets?: boolean;
  /**
   * Maximum number of chunks embedded per `embedder.embed()` call in
   * {@link RagIndex.index} (default 128). Rather than embedding the whole
   * corpus in one batch (which duplicates every chunk's text + vector in
   * memory simultaneously), chunks are embedded and stored in bounded windows,
   * releasing each batch before the next — an aggregate-memory DoS guard
   * (system-spec §16). Batching never changes the resulting vectors: each text
   * is embedded independently of batch boundaries.
   */
  batchSize?: number;
}

export class RagIndex {
  private readonly embedder: Embedder;
  private readonly store: VectorStore;
  private readonly chunkOpts: ChunkOptions;
  private readonly bm25: Bm25Index;
  private readonly reranker: Reranker;
  private readonly file: string | undefined;
  private readonly redact: boolean;
  private readonly batchSize: number;
  private bm25Dirty = true;

  constructor(opts: RagIndexOptions) {
    this.embedder = opts.embedder;
    this.store =
      opts.store ??
      new InMemoryVectorStore(opts.embedder.dims, {
        embedderId: opts.embedder.id,
        ...(opts.file !== undefined ? { file: opts.file } : {}),
      });
    if (this.store.dims !== this.embedder.dims) {
      throw new Error(
        `RagIndex: store dims (${this.store.dims}) ≠ embedder dims (${this.embedder.dims})`,
      );
    }
    this.chunkOpts = opts.chunk ?? {};
    this.bm25 = new Bm25Index(opts.bm25 ?? {});
    this.reranker = opts.reranker ?? scoreReranker;
    this.file = opts.file;
    this.redact = opts.redactSecrets ?? true;
    this.batchSize = opts.batchSize && opts.batchSize > 0 ? opts.batchSize : 128;
  }

  /** Number of stored chunks. */
  get size(): number {
    return this.store.size;
  }

  /** The underlying vector store (for advanced callers / persistence). */
  get vectorStore(): VectorStore {
    return this.store;
  }

  /**
   * Chunk, embed, and store one or more documents. Re-indexing a document id
   * replaces its previous chunks. Returns the chunks that were stored.
   *
   * Embedding is streamed in bounded batches of {@link RagIndexOptions.batchSize}
   * chunks (default 128) rather than one `embedder.embed()` call over the whole
   * corpus — each batch's vectors are added to the store and the batch released
   * before the next is embedded, so at most one batch's worth of chunk text +
   * vectors is held at once instead of duplicating the entire corpus in memory
   * (aggregate-memory DoS guard, system-spec §16). Batch size never changes the
   * resulting vectors: the embedder embeds each text independently.
   */
  async index(documents: RagDocument | RagDocument[]): Promise<Chunk[]> {
    const docs = Array.isArray(documents) ? documents : [documents];
    const allChunks: Chunk[] = [];
    let pending: Chunk[] = [];

    const flush = async (): Promise<void> => {
      if (pending.length === 0) return;
      const vectors = await this.embedder.embed(pending.map((c) => c.text));
      this.store.add(pending.map((chunk, i) => ({ id: chunk.id, vector: vectors[i]!, chunk })));
      pending = [];
    };

    for (const doc of docs) {
      this.store.deleteByDoc(doc.id); // idempotent re-index
      const chunks = chunkDocument(doc, this.chunkOpts);
      // Redact secrets in-place BEFORE the text reaches the embedder, the vector
      // store, the BM25 index, or persistence — so nothing sensitive is embedded
      // (no remote exfiltration), stored, or later surfaced as retrieved context.
      if (this.redact) {
        for (const chunk of chunks) chunk.text = redactSecrets(chunk.text);
      }
      for (const chunk of chunks) {
        allChunks.push(chunk);
        pending.push(chunk);
        if (pending.length >= this.batchSize) await flush();
      }
    }
    await flush();

    this.bm25Dirty = true;
    return allChunks;
  }

  /**
   * Incremental re-index (system-spec §23): (re)embed ONLY the documents whose
   * content actually changed since the last pass, skipping unchanged ones so no
   * embedder call — and no remote embedding request — is spent on them.
   *
   * Each document's text is SHA-256'd and compared against the hash stamped into
   * its stored chunks ({@link DOC_HASH_META}). A matching hash ⇒ skip (nothing is
   * embedded or touched). A new/changed hash ⇒ the document is re-chunked and
   * re-embedded (replacing its prior chunks), and the fresh hash is stamped for
   * next time. With `prune`, documents that vanished from the input are removed.
   *
   * This is the cheap path a watch-mode loop calls on every debounced change:
   * one edited file re-embeds one document; the rest of the corpus is untouched.
   */
  async incrementalIndex(
    documents: RagDocument | RagDocument[],
    opts: { prune?: boolean } = {},
  ): Promise<IncrementalIndexResult> {
    const docs = Array.isArray(documents) ? documents : [documents];

    // Current per-document content hash, read from the stored chunks' meta.
    const storedHash = new Map<string, string>();
    for (const chunk of this.store.chunks()) {
      if (storedHash.has(chunk.docId)) continue;
      const h = chunk.meta?.[DOC_HASH_META];
      if (typeof h === "string") storedHash.set(chunk.docId, h);
    }

    const indexed: string[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    const toIndex: RagDocument[] = [];

    for (const doc of docs) {
      seen.add(doc.id);
      const hash = createHash("sha256").update(doc.text).digest("hex");
      if (storedHash.get(doc.id) === hash) {
        skipped.push(doc.id);
        continue;
      }
      // Stamp the fresh hash into the doc's metadata so it propagates onto every
      // chunk (chunkDocument copies `meta`) and future runs can compare it.
      toIndex.push({ ...doc, meta: { ...(doc.meta ?? {}), [DOC_HASH_META]: hash } });
      indexed.push(doc.id);
    }

    const removed: string[] = [];
    if (opts.prune) {
      for (const docId of storedHash.keys()) {
        if (!seen.has(docId) && this.remove(docId) > 0) removed.push(docId);
      }
    }

    // Only the changed/new documents reach the embedder.
    if (toIndex.length > 0) await this.index(toIndex);

    return { indexed, skipped, removed };
  }

  /** Remove a document and all its chunks. Returns how many chunks were removed. */
  remove(docId: string): number {
    const n = this.store.deleteByDoc(docId);
    if (n > 0) this.bm25Dirty = true;
    return n;
  }

  /**
   * Run a hybrid (default) / semantic / keyword query and return ranked, cited
   * results. Candidates are the metadata-filtered chunks; both signals are
   * min-max normalized before blending so `alpha` is a true 0..1 mix.
   */
  async query(text: string, opts: QueryOptions = {}): Promise<QueryResult[]> {
    const topK = opts.topK ?? 5;
    const mode: SearchMode = opts.mode ?? "hybrid";
    const alpha = clamp01(opts.alpha ?? 0.5);
    const reranker = opts.reranker ?? this.reranker;

    this.ensureBm25();

    // Redact secrets in the query text BEFORE it reaches the embedder — the same
    // "no secret leaves this process" invariant `index()` enforces on chunk text
    // (line ~142). Without this, a query containing a live API key/token would be
    // sent verbatim to a remote embedder (e.g. api.openai.com), exfiltrating it —
    // the exact leak the index path already guards against. Redaction only
    // rewrites text that actually contains a secret, so ordinary queries and the
    // BM25/keyword scoring below (which uses the original `text`, never sent
    // anywhere) are unaffected.
    const queryForEmbedding = this.redact ? redactSecrets(text) : text;

    // Semantic scores + the candidate chunk set (already metadata-filtered).
    const [qvec] = await this.embedder.embed([queryForEmbedding]);
    const semanticHits = this.store.search(qvec!, -1, opts.filter);
    const semanticRaw = new Map<string, number>();
    const chunkById = new Map<string, Chunk>();
    for (const hit of semanticHits) {
      semanticRaw.set(hit.id, hit.score);
      chunkById.set(hit.id, hit.chunk);
    }

    // Keyword scores, restricted to the same candidate set.
    const keywordRaw = new Map<string, number>();
    if (mode !== "semantic") {
      for (const [id, score] of this.bm25.scoreAll(text)) {
        if (chunkById.has(id)) keywordRaw.set(id, score);
      }
    }

    const semNorm = minMaxNormalize(semanticRaw);
    const kwNorm = minMaxNormalize(keywordRaw);

    const blend =
      mode === "semantic" ? 1 : mode === "keyword" ? 0 : alpha;

    const results: QueryResult[] = [];
    for (const [id, chunk] of chunkById) {
      const sN = semNorm.get(id) ?? 0;
      const kN = kwNorm.get(id) ?? 0;
      const score = blend * sN + (1 - blend) * kN;
      // Drop true non-matches in keyword mode (no lexical overlap ⇒ score 0).
      if (mode === "keyword" && !keywordRaw.has(id)) continue;
      results.push({
        chunk,
        score,
        semanticScore: semanticRaw.get(id) ?? 0,
        keywordScore: keywordRaw.get(id) ?? 0,
        citation: toCitation(chunk),
      });
    }

    const ranked = reranker(text, results);
    return topK >= 0 ? ranked.slice(0, topK) : ranked;
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  /** Persist the vector store (chunks + vectors) to JSON. Returns the file path. */
  save(file?: string): string {
    return this.store.save(file ?? this.file);
  }

  /** Restore from JSON and rebuild the keyword index from the loaded chunks. */
  load(file?: string): void {
    this.store.load(file ?? this.file);
    this.bm25Dirty = true;
  }

  private ensureBm25(): void {
    if (this.bm25Dirty) {
      this.bm25.rebuild(this.store.chunks());
      this.bm25Dirty = false;
    }
  }
}

function toCitation(chunk: Chunk): Citation {
  const citation: Citation = { docId: chunk.docId, span: chunk.span };
  if (chunk.source !== undefined) citation.source = chunk.source;
  if (chunk.lang !== undefined) citation.lang = chunk.lang;
  return citation;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
