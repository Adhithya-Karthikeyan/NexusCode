/**
 * InMemoryVectorStore — the default {@link VectorStore} (system-spec §16 "vector
 * databases"). Exact cosine search over an in-memory map, with add / search(topK)
 * / delete and JSON persistence to a data-dir file (atomic temp+rename, 0600).
 *
 * It is deliberately behind the {@link VectorStore} interface so a real ANN
 * library (hnswlib, faiss, …) can slot in later without touching callers. Vectors
 * are stored L2-normalized-agnostic: cosine is computed honestly from raw norms,
 * so it is correct even if an embedder does not pre-normalize.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ragStoreFile } from "./paths.js";
import type {
  Chunk,
  MetadataFilter,
  VectorHit,
  VectorItem,
  VectorStore,
  VectorStoreSnapshot,
} from "./types.js";

interface StoredEntry {
  id: string;
  vector: number[];
  norm: number;
  chunk: Chunk;
}

export interface InMemoryVectorStoreOptions {
  /** Embedder id stamped into snapshots so mismatched vectors are detectable. */
  embedderId?: string;
  /** Default persistence file (overridable per `save`/`load` call). */
  file?: string;
}

export class InMemoryVectorStore implements VectorStore {
  readonly dims: number;
  private readonly embedderId: string;
  private readonly defaultFile: string | undefined;
  private readonly items = new Map<string, StoredEntry>();

  constructor(dims: number, opts: InMemoryVectorStoreOptions = {}) {
    if (!Number.isInteger(dims) || dims <= 0) {
      throw new Error(`InMemoryVectorStore: dims must be a positive integer, got ${dims}`);
    }
    this.dims = dims;
    this.embedderId = opts.embedderId ?? "unknown";
    this.defaultFile = opts.file;
  }

  get size(): number {
    return this.items.size;
  }

  add(items: VectorItem[]): void {
    for (const it of items) {
      if (it.vector.length !== this.dims) {
        throw new Error(
          `vector store: dim mismatch for "${it.id}" — expected ${this.dims}, got ${it.vector.length}`,
        );
      }
      const vector = it.vector.slice();
      this.items.set(it.id, { id: it.id, vector, norm: norm(vector), chunk: it.chunk });
    }
  }

  search(query: number[], topK: number, filter?: MetadataFilter): VectorHit[] {
    if (query.length !== this.dims) {
      throw new Error(
        `vector store: query dim mismatch — expected ${this.dims}, got ${query.length}`,
      );
    }
    const qNorm = norm(query);
    const hits: VectorHit[] = [];
    for (const entry of this.items.values()) {
      if (filter && !matchFilter(entry.chunk, filter)) continue;
      const denom = qNorm * entry.norm;
      const score = denom === 0 ? 0 : dotRaw(query, entry.vector) / denom;
      hits.push({ id: entry.id, score, chunk: entry.chunk });
    }
    hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return topK >= 0 ? hits.slice(0, topK) : hits;
  }

  delete(ids: string[]): number {
    let n = 0;
    for (const id of ids) if (this.items.delete(id)) n++;
    return n;
  }

  deleteByDoc(docId: string): number {
    const ids: string[] = [];
    for (const entry of this.items.values()) {
      if (entry.chunk.docId === docId) ids.push(entry.id);
    }
    return this.delete(ids);
  }

  clear(): void {
    this.items.clear();
  }

  chunks(): Chunk[] {
    return [...this.items.values()].map((e) => e.chunk);
  }

  toJSON(): VectorStoreSnapshot {
    return {
      version: 1,
      embedderId: this.embedderId,
      dims: this.dims,
      items: [...this.items.values()].map((e) => ({
        id: e.id,
        vector: e.vector.slice(),
        chunk: e.chunk,
      })),
    };
  }

  save(file?: string): string {
    const target = file ?? this.defaultFile ?? ragStoreFile();
    const dir = dirname(target);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.toJSON(), null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(tmp, target);
    try {
      chmodSync(target, 0o600);
    } catch {
      /* best-effort on platforms without POSIX perms */
    }
    return target;
  }

  load(file?: string): void {
    const target = file ?? this.defaultFile ?? ragStoreFile();
    if (!existsSync(target)) return;
    let snap: VectorStoreSnapshot;
    try {
      snap = JSON.parse(readFileSync(target, "utf8")) as VectorStoreSnapshot;
    } catch {
      return; // corrupt/unreadable: start empty rather than crash
    }
    if (snap.dims !== this.dims) {
      throw new Error(
        `vector store load: dim mismatch — store is ${this.dims}, file is ${snap.dims}`,
      );
    }
    this.items.clear();
    for (const it of snap.items ?? []) {
      if (!it || typeof it.id !== "string" || !Array.isArray(it.vector)) continue;
      const vector = it.vector.slice();
      this.items.set(it.id, { id: it.id, vector, norm: norm(vector), chunk: it.chunk });
    }
  }
}

/** True when a chunk satisfies every present clause of the filter (AND). */
export function matchFilter(chunk: Chunk, filter: MetadataFilter): boolean {
  if (filter.docId !== undefined && chunk.docId !== filter.docId) return false;
  if (filter.source !== undefined && chunk.source !== filter.source) return false;
  if (filter.lang !== undefined && chunk.lang !== filter.lang) return false;
  if (filter.meta) {
    const meta = chunk.meta ?? {};
    for (const [k, v] of Object.entries(filter.meta)) {
      if (!deepEqual(meta[k], v)) return false;
    }
  }
  if (filter.predicate && !filter.predicate(chunk)) return false;
  return true;
}

function dotRaw(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

function norm(v: number[]): number {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}
