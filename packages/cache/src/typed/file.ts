/**
 * FileCache — memoizes work derived from a file (parsed content, extracted
 * symbols, a repo-map fragment) keyed by the file path, and *invalidated* when
 * the file changes (system-spec §17: file cache). The change signal is a
 * {@link FileFingerprint} — mtime + size, cheap to obtain from a `stat` — so File
 * Intelligence never re-parses an unchanged file, and always re-parses a changed
 * one.
 *
 * `V` is whatever the caller derives (an AST summary, a symbol list, a hash).
 */

import { hashKey } from "../keys.js";
import { CacheAccounting } from "../accounting.js";
import type { CacheBackend, CacheStats } from "../types.js";

/** Cheap change-detector for a file: mtime (ms) + byte size. */
export interface FileFingerprint {
  mtimeMs: number;
  size: number;
}

/** Stored envelope: the fingerprint the value was derived under, plus the value. */
export interface FileCacheEntry<V> {
  fingerprint: FileFingerprint;
  value: V;
}

export interface FileCacheOptions<V> {
  backend: CacheBackend<FileCacheEntry<V>>;
  /** TTL (ms) for entries; omit to rely on fingerprint invalidation alone. */
  ttlMs?: number;
}

function fingerprintEquals(a: FileFingerprint, b: FileFingerprint): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

export class FileCache<V> {
  private readonly backend: CacheBackend<FileCacheEntry<V>>;
  private readonly ttlMs: number | undefined;
  private readonly accounting = new CacheAccounting();

  constructor(opts: FileCacheOptions<V>) {
    this.backend = opts.backend;
    this.ttlMs = opts.ttlMs;
  }

  /** Deterministic key for a file path. */
  key(path: string): string {
    return hashKey("file", path);
  }

  /**
   * Return the cached value only when the stored fingerprint matches the
   * caller's current one (i.e. the file is unchanged). A fingerprint mismatch
   * is a miss *and* evicts the stale entry so it won't be served again.
   */
  async get(path: string, current: FileFingerprint): Promise<V | undefined> {
    const key = this.key(path);
    const entry = await this.backend.get(key);
    if (entry && fingerprintEquals(entry.fingerprint, current)) {
      this.accounting.recordHit();
      return entry.value;
    }
    if (entry) {
      // Stale: the file changed under the cached derivation. Drop it.
      await this.backend.delete(key);
    }
    this.accounting.recordMiss();
    return undefined;
  }

  /** Store a derived value under the file's current fingerprint. */
  async set(path: string, current: FileFingerprint, value: V): Promise<void> {
    await this.backend.set(
      this.key(path),
      { fingerprint: current, value },
      { ...(this.ttlMs !== undefined ? { ttlMs: this.ttlMs } : {}) },
    );
    this.accounting.recordWrite();
  }

  async delete(path: string): Promise<boolean> {
    return this.backend.delete(this.key(path));
  }

  async clear(): Promise<void> {
    await this.backend.clear();
    this.accounting.reset();
  }

  async stats(): Promise<CacheStats> {
    return this.accounting.snapshot(this.backend.name, this.backend.metrics(), await this.backend.size());
  }
}
