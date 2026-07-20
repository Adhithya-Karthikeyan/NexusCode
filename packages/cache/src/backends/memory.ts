/**
 * MemoryCache — an in-process {@link CacheBackend} with LRU capacity bounding and
 * per-entry TTL (system-spec §17: memory cache). A `Map` preserves insertion
 * order; a successful `get` re-inserts the key so the least-recently-used entry
 * is always the map's first key and therefore the eviction victim. Expiry is
 * lazy: an entry past its `expiresAt` is dropped on access and counted as an
 * expiration.
 */

import type {
  BackendMetrics,
  CacheBackend,
  Clock,
  SetOptions,
  StoredEntry,
} from "../types.js";

export interface MemoryCacheOptions {
  /** Max live entries; when exceeded, the least-recently-used entry is evicted. */
  maxEntries?: number;
  /** Default TTL (ms) applied to writes that don't specify one. */
  defaultTtlMs?: number;
  /** Injectable clock for deterministic TTL/eviction tests. */
  now?: Clock;
}

export class MemoryCache<V> implements CacheBackend<V> {
  readonly name = "memory";
  private readonly store = new Map<string, StoredEntry<V>>();
  private readonly maxEntries: number;
  private readonly defaultTtlMs: number | undefined;
  private readonly clock: Clock;
  private evictions = 0;
  private expirations = 0;

  constructor(opts: MemoryCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? Number.POSITIVE_INFINITY;
    this.defaultTtlMs = opts.defaultTtlMs;
    this.clock = opts.now ?? Date.now;
  }

  private isExpired(entry: StoredEntry<V>, now: number): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= now;
  }

  async get(key: string): Promise<V | undefined> {
    const now = this.clock();
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry, now)) {
      this.store.delete(key);
      this.expirations += 1;
      return undefined;
    }
    // Mark most-recently-used: delete + re-insert moves it to the map's tail.
    this.store.delete(key);
    entry.hits += 1;
    entry.lastAccess = now;
    this.store.set(key, entry);
    return entry.value;
  }

  async peek(key: string): Promise<StoredEntry<V> | undefined> {
    const now = this.clock();
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry, now)) {
      this.store.delete(key);
      this.expirations += 1;
      return undefined;
    }
    return { ...entry };
  }

  async set(key: string, value: V, opts: SetOptions = {}): Promise<void> {
    const now = this.clock();
    const ttlMs = opts.ttlMs ?? this.defaultTtlMs;
    const entry: StoredEntry<V> = {
      key,
      value,
      createdAt: now,
      lastAccess: now,
      hits: 0,
      ...(ttlMs !== undefined ? { expiresAt: now + ttlMs } : {}),
    };
    // Overwrite as a fresh insertion so it becomes most-recently-used.
    this.store.delete(key);
    this.store.set(key, entry);
    this.evictToCapacity();
  }

  private evictToCapacity(): void {
    while (this.store.size > this.maxEntries) {
      const oldest = this.store.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.store.delete(oldest);
      this.evictions += 1;
    }
  }

  async has(key: string): Promise<boolean> {
    const now = this.clock();
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry, now)) {
      this.store.delete(key);
      this.expirations += 1;
      return false;
    }
    return true;
  }

  async delete(key: string): Promise<boolean> {
    return this.store.delete(key);
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async size(): Promise<number> {
    // Sweep expired entries so the count reflects only live records.
    const now = this.clock();
    for (const [key, entry] of this.store) {
      if (this.isExpired(entry, now)) {
        this.store.delete(key);
        this.expirations += 1;
      }
    }
    return this.store.size;
  }

  async keys(): Promise<string[]> {
    const now = this.clock();
    const out: string[] = [];
    for (const [key, entry] of this.store) {
      if (this.isExpired(entry, now)) {
        this.store.delete(key);
        this.expirations += 1;
        continue;
      }
      out.push(entry.key);
    }
    return out;
  }

  metrics(): BackendMetrics {
    return { evictions: this.evictions, expirations: this.expirations };
  }
}
