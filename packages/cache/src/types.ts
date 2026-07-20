/**
 * Public shapes for the caching subsystem (system-spec §17 — CAG / Caching).
 *
 * A {@link CacheBackend} is the low-level store: it holds {@link StoredEntry}
 * records under string keys, honours per-entry TTL, and (for memory) enforces an
 * LRU capacity bound. Typed caches ({@link PromptCache}, {@link ResponseCache},
 * {@link EmbeddingCache}, {@link FileCache}) sit on top of a backend, own a
 * deterministic key strategy + default TTL, and track savings via
 * {@link CacheAccounting} into a {@link CacheStats} snapshot.
 *
 * Every clock is injectable (`now`) so TTL/eviction behaviour is deterministic
 * under test — no wall-clock or network dependence anywhere in this package.
 */

/** Injectable monotonic-ish clock; defaults to `Date.now`. */
export type Clock = () => number;

/** A stored value plus its bookkeeping. `expiresAt` absent = never expires. */
export interface StoredEntry<V> {
  /** The original (pre-hash) key, retained so a backend can enumerate keys. */
  key: string;
  value: V;
  /** Epoch millis when written. */
  createdAt: number;
  /** Epoch millis of the last successful read (drives disk LRU pruning). */
  lastAccess: number;
  /** Absolute epoch-millis expiry; `undefined` means the entry never expires. */
  expiresAt?: number;
  /** Number of times this entry has been served as a hit. */
  hits: number;
}

/** Per-write options. */
export interface SetOptions {
  /** Time-to-live in milliseconds from now; omit to use the backend default. */
  ttlMs?: number;
}

/** Backend-level counters merged into a {@link CacheStats} snapshot. */
export interface BackendMetrics {
  /** Entries dropped to stay within an LRU capacity bound. */
  evictions: number;
  /** Entries dropped because their TTL had elapsed on access. */
  expirations: number;
}

/**
 * The unified cache abstraction. Both {@link MemoryCache} and {@link DiskCache}
 * implement it, so a typed cache can be pointed at either with no code change.
 * All methods are async to keep the disk and memory backends interchangeable.
 */
export interface CacheBackend<V> {
  /** Human-readable backend label (`"memory"` / `"disk"`), surfaced in stats. */
  readonly name: string;
  /** Return the live value, or `undefined` on miss/expiry. Touches LRU order. */
  get(key: string): Promise<V | undefined>;
  /** Inspect the raw entry without affecting LRU order (expired → `undefined`). */
  peek(key: string): Promise<StoredEntry<V> | undefined>;
  /** Write (or overwrite) a value, honouring `ttlMs` or the backend default. */
  set(key: string, value: V, opts?: SetOptions): Promise<void>;
  /** True when a live (non-expired) entry exists. */
  has(key: string): Promise<boolean>;
  /** Remove one entry; resolves `true` when something was removed. */
  delete(key: string): Promise<boolean>;
  /** Drop every entry this backend owns. */
  clear(): Promise<void>;
  /** Number of live entries. */
  size(): Promise<number>;
  /** Enumerate the original keys of live entries. */
  keys(): Promise<string[]>;
  /** Eviction/expiration counters accumulated since construction. */
  metrics(): BackendMetrics;
}

/** Tokens/cost a cache hit avoided (used by {@link CacheAccounting.recordHit}). */
export interface Savings {
  inputTokens?: number;
  outputTokens?: number;
  /** Precomputed USD saved; when absent, callers pass token buckets + pricing. */
  costUsd?: number;
}

/**
 * A point-in-time accounting snapshot for one typed cache: request-level
 * hit/miss/write counts, backend eviction/expiration counts, live size, and the
 * running estimate of tokens and USD *saved* by serving hits from cache.
 */
export interface CacheStats {
  /** The backing store label (`"memory"` / `"disk"`). */
  backend: string;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  expirations: number;
  /** Live entry count at snapshot time. */
  size: number;
  /** `hits / (hits + misses)`, or 0 when there have been no reads. */
  hitRate: number;
  savedInputTokens: number;
  savedOutputTokens: number;
  /** `savedInputTokens + savedOutputTokens`. */
  savedTokens: number;
  /** Estimated USD saved by cache hits (priced or caller-reported). */
  estimatedCostSavedUsd: number;
}
