/**
 * DiskCache — a persistent {@link CacheBackend} that stores one JSON file per
 * entry under a namespaced directory (system-spec §17: disk cache). It follows
 * the same on-disk safety convention as the rest of NexusCode: the cache dir is
 * created 0700, every file is written atomically (temp file + rename) with 0600
 * perms so cached prompts/responses are never world-readable.
 *
 * Entries survive process restarts. TTL is enforced lazily on read (an expired
 * file is unlinked and counted). An optional `maxEntries` bound prunes the
 * oldest files by write time so an unbounded cache can't fill the disk.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { keyToFilename } from "../keys.js";
import type {
  BackendMetrics,
  CacheBackend,
  Clock,
  SetOptions,
  StoredEntry,
} from "../types.js";

export interface DiskCacheOptions {
  /** Base directory for cache files (typically the app cache dir). */
  dir: string;
  /** Sub-namespace under `dir`, isolating one typed cache's files. */
  namespace?: string;
  /** Default TTL (ms) applied to writes that don't specify one. */
  defaultTtlMs?: number;
  /** Max stored files; when exceeded, the oldest-written files are pruned. */
  maxEntries?: number;
  /** Injectable clock for deterministic TTL tests. */
  now?: Clock;
}

export class DiskCache<V> implements CacheBackend<V> {
  readonly name = "disk";
  private readonly dir: string;
  private readonly defaultTtlMs: number | undefined;
  private readonly maxEntries: number;
  private readonly clock: Clock;
  private evictions = 0;
  private expirations = 0;

  constructor(opts: DiskCacheOptions) {
    this.dir = opts.namespace ? join(opts.dir, opts.namespace) : opts.dir;
    this.defaultTtlMs = opts.defaultTtlMs;
    this.maxEntries = opts.maxEntries ?? Number.POSITIVE_INFINITY;
    this.clock = opts.now ?? Date.now;
  }

  private pathFor(key: string): string {
    return join(this.dir, `${keyToFilename(key)}.json`);
  }

  private ensureDir(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  private isExpired(entry: StoredEntry<V>, now: number): boolean {
    return entry.expiresAt !== undefined && entry.expiresAt <= now;
  }

  private read(key: string): StoredEntry<V> | undefined {
    const file = this.pathFor(key);
    if (!existsSync(file)) return undefined;
    try {
      return JSON.parse(readFileSync(file, "utf8")) as StoredEntry<V>;
    } catch {
      // Corrupt entry: treat as a miss and remove it.
      try {
        unlinkSync(file);
      } catch {
        /* ignore */
      }
      return undefined;
    }
  }

  private write(entry: StoredEntry<V>): void {
    this.ensureDir();
    const file = this.pathFor(entry.key);
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    try {
      chmodSync(file, 0o600);
    } catch {
      /* best-effort on platforms without POSIX perms */
    }
  }

  async get(key: string): Promise<V | undefined> {
    const now = this.clock();
    const entry = this.read(key);
    if (!entry) return undefined;
    if (this.isExpired(entry, now)) {
      this.dropFile(key);
      this.expirations += 1;
      return undefined;
    }
    entry.hits += 1;
    entry.lastAccess = now;
    this.write(entry); // persist updated access bookkeeping
    return entry.value;
  }

  async peek(key: string): Promise<StoredEntry<V> | undefined> {
    const now = this.clock();
    const entry = this.read(key);
    if (!entry) return undefined;
    if (this.isExpired(entry, now)) {
      this.dropFile(key);
      this.expirations += 1;
      return undefined;
    }
    return entry;
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
    this.write(entry);
    this.pruneToCapacity();
  }

  private pruneToCapacity(): void {
    if (!Number.isFinite(this.maxEntries)) return;
    const files = this.listFiles();
    if (files.length <= this.maxEntries) return;
    // Sort oldest-first by createdAt, then unlink the surplus.
    const scored = files
      .map((f) => {
        const entry = this.readFile(f);
        return { f, createdAt: entry?.createdAt ?? 0 };
      })
      .sort((a, b) => a.createdAt - b.createdAt);
    const surplus = scored.length - this.maxEntries;
    for (let i = 0; i < surplus; i++) {
      try {
        unlinkSync(join(this.dir, scored[i]!.f));
        this.evictions += 1;
      } catch {
        /* ignore */
      }
    }
  }

  private listFiles(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((f) => f.endsWith(".json"));
  }

  private readFile(fileName: string): StoredEntry<V> | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir, fileName), "utf8")) as StoredEntry<V>;
    } catch {
      return undefined;
    }
  }

  private dropFile(key: string): void {
    try {
      unlinkSync(this.pathFor(key));
    } catch {
      /* already gone */
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.peek(key)) !== undefined;
  }

  async delete(key: string): Promise<boolean> {
    const file = this.pathFor(key);
    if (!existsSync(file)) return false;
    this.dropFile(key);
    return true;
  }

  async clear(): Promise<void> {
    if (!existsSync(this.dir)) return;
    rmSync(this.dir, { recursive: true, force: true });
  }

  async size(): Promise<number> {
    return (await this.keys()).length;
  }

  async keys(): Promise<string[]> {
    const now = this.clock();
    const out: string[] = [];
    for (const fileName of this.listFiles()) {
      const entry = this.readFile(fileName);
      if (!entry) continue;
      if (this.isExpired(entry, now)) {
        try {
          unlinkSync(join(this.dir, fileName));
          this.expirations += 1;
        } catch {
          /* ignore */
        }
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
