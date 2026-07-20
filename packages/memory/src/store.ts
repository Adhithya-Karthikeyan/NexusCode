/**
 * MemoryStore — one clean API over three tiers (system-spec §4).
 *
 *  - `short`     lives only in memory for the life of the process/session.
 *  - `long` and `knowledge` are persisted to a single JSON file under the data
 *    dir, written atomically (temp file + rename) with 0600 perms.
 *
 * Every mutation restamps `updatedAt`, so the durable file is a fully auditable
 * record of what changed and when. Relevance ranking is pluggable via `scorer`
 * (default: lexical) — the seam for future embedding-based recall.
 */

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { memoryFile } from "./paths.js";
import { estimateTokens, lexicalScore } from "./score.js";
import type {
  MemoryFilter,
  MemoryItem,
  MemoryPatch,
  MemoryPut,
  MemoryTier,
  ScoreFn,
  SearchHit,
  SearchOptions,
} from "./types.js";

/** Persisted on-disk shape. `short` is never written. */
interface MemoryFileShape {
  version: 1;
  items: { long: MemoryItem[]; knowledge: MemoryItem[] };
}

const DURABLE_TIERS: readonly MemoryTier[] = ["long", "knowledge"];

/** The scratchpad is a singleton item in the short tier under a fixed id. */
const SCRATCHPAD_ID = "short:scratchpad";

export interface MemoryStoreOptions {
  /** Explicit data directory (overrides `NEXUS_DATA_DIR` and the default). */
  dir?: string;
  /** Explicit persistence file path (overrides `dir`). Use ":memory:" to disable disk. */
  file?: string;
  /** Session id stamped onto short-tier items' `source`. */
  sessionId?: string;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Relevance scorer. Default: {@link lexicalScore}. */
  scorer?: ScoreFn;
  /** Environment for path/env resolution (tests). */
  env?: NodeJS.ProcessEnv;
}

/**
 * The unified memory API. Construct via {@link openMemory}.
 */
export class MemoryStore {
  private readonly tiers: Record<MemoryTier, Map<string, MemoryItem>> = {
    short: new Map(),
    long: new Map(),
    knowledge: new Map(),
  };

  private readonly filePath: string | null;
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly scorer: ScoreFn;

  constructor(opts: MemoryStoreOptions = {}) {
    this.filePath =
      opts.file === ":memory:"
        ? null
        : (opts.file ?? memoryFile(opts.dir, opts.env ?? process.env));
    this.sessionId = opts.sessionId ?? "session";
    this.now = opts.now ?? Date.now;
    this.scorer = opts.scorer ?? lexicalScore;
    this.load();
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  /** Fetch by id across all tiers. */
  get(id: string): MemoryItem | undefined {
    for (const tier of ["short", "long", "knowledge"] as const) {
      const hit = this.tiers[tier].get(id);
      if (hit) return clone(hit);
    }
    return undefined;
  }

  /**
   * Insert or upsert. When `input.id` names an existing item its `createdAt` is
   * preserved and `updatedAt` restamped; otherwise a fresh item is created.
   */
  put(input: MemoryPut): MemoryItem {
    const ts = this.now();
    const id = input.id ?? `mem_${randomUUID()}`;
    const existing = this.tiers[input.tier].get(id);

    const item: MemoryItem = {
      id,
      tier: input.tier,
      kind: input.kind,
      text: input.text,
      createdAt: existing?.createdAt ?? ts,
      updatedAt: ts,
      ...(input.tags !== undefined ? { tags: [...input.tags] } : {}),
      ...(input.source !== undefined ? { source: input.source } : {}),
    };

    this.tiers[input.tier].set(id, item);
    this.persistIfDurable(input.tier);
    return clone(item);
  }

  /** Patch mutable fields and restamp `updatedAt`. Returns the updated item. */
  update(id: string, patch: MemoryPatch): MemoryItem {
    const tier = this.tierOf(id);
    if (!tier) throw new Error(`memory: no item with id "${id}"`);
    const cur = this.tiers[tier].get(id) as MemoryItem;

    const next: MemoryItem = {
      ...cur,
      updatedAt: this.now(),
      ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
      ...(patch.text !== undefined ? { text: patch.text } : {}),
      ...(patch.tags !== undefined ? { tags: [...patch.tags] } : {}),
      ...(patch.source !== undefined ? { source: patch.source } : {}),
    };

    this.tiers[tier].set(id, next);
    this.persistIfDurable(tier);
    return clone(next);
  }

  /** Delete by id. Returns whether an item was removed. */
  delete(id: string): boolean {
    const tier = this.tierOf(id);
    if (!tier) return false;
    this.tiers[tier].delete(id);
    this.persistIfDurable(tier);
    return true;
  }

  /** List items matching a filter, oldest-first (stable, auditable order). */
  list(filter: MemoryFilter = {}): MemoryItem[] {
    const tiers = filter.tier ? [filter.tier] : (["short", "long", "knowledge"] as const);
    const out: MemoryItem[] = [];
    for (const tier of tiers) {
      for (const item of this.tiers[tier].values()) {
        if (filter.kind !== undefined && item.kind !== filter.kind) continue;
        if (filter.source !== undefined && item.source !== filter.source) continue;
        if (filter.tag !== undefined && !(item.tags ?? []).includes(filter.tag)) continue;
        out.push(clone(item));
      }
    }
    out.sort(byCreatedThenId);
    return out;
  }

  // ── Search & recall ─────────────────────────────────────────────────────────

  /**
   * Score every candidate item against `query` and return non-zero hits,
   * highest score first. Ties break by most-recently-updated then id, so the
   * order is deterministic.
   */
  search(query: string, opts: SearchOptions = {}): SearchHit[] {
    const tiers = opts.tier ? [opts.tier] : (["short", "long", "knowledge"] as const);
    const hits: SearchHit[] = [];
    for (const tier of tiers) {
      for (const item of this.tiers[tier].values()) {
        if (opts.kind !== undefined && item.kind !== opts.kind) continue;
        const score = this.scorer(query, item);
        if (score > 0) hits.push({ item: clone(item), score });
      }
    }
    hits.sort(byScoreThenRecency);
    return typeof opts.limit === "number" ? hits.slice(0, opts.limit) : hits;
  }

  /**
   * Return the most relevant items for context injection, greedily packed under
   * `budgetTokens` (estimated). Items are considered in descending relevance;
   * an item is included when it fits the remaining budget. Returns items in the
   * order they were selected (most relevant first).
   */
  recall(query: string, budgetTokens: number): MemoryItem[] {
    if (budgetTokens <= 0) return [];
    const ranked = this.search(query);
    const picked: MemoryItem[] = [];
    let used = 0;
    for (const { item } of ranked) {
      const cost = estimateTokens(item.text);
      if (used + cost > budgetTokens) continue; // try smaller lower-ranked items
      picked.push(item);
      used += cost;
    }
    return picked;
  }

  // ── Short-tier conveniences (conversation + scratchpad) ─────────────────────

  /** Append a conversation turn to the short tier. `role` is stored as a tag. */
  recordTurn(role: string, text: string): MemoryItem {
    return this.put({
      tier: "short",
      kind: "conversation",
      text,
      tags: [`role:${role}`],
      source: this.sessionId,
    });
  }

  /** Conversation turns in the short tier, oldest-first. */
  turns(): MemoryItem[] {
    return this.list({ tier: "short", kind: "conversation" });
  }

  /** Set (or replace) the session scratchpad. */
  setScratchpad(text: string): MemoryItem {
    return this.put({
      tier: "short",
      kind: "scratchpad",
      text,
      id: SCRATCHPAD_ID,
      source: this.sessionId,
    });
  }

  /** Current scratchpad text, if any. */
  scratchpad(): string | undefined {
    return this.tiers.short.get(SCRATCHPAD_ID)?.text;
  }

  // ── Maintenance ─────────────────────────────────────────────────────────────

  /** Clear a single tier, or every tier when omitted. Persists durable tiers. */
  clear(tier?: MemoryTier): void {
    const targets = tier ? [tier] : (["short", "long", "knowledge"] as const);
    for (const t of targets) {
      this.tiers[t].clear();
      this.persistIfDurable(t);
    }
  }

  /** Absolute path of the durable file (or null when disk is disabled). */
  get path(): string | null {
    return this.filePath;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private tierOf(id: string): MemoryTier | null {
    for (const tier of ["short", "long", "knowledge"] as const) {
      if (this.tiers[tier].has(id)) return tier;
    }
    return null;
  }

  private persistIfDurable(tier: MemoryTier): void {
    if (DURABLE_TIERS.includes(tier)) this.save();
  }

  private load(): void {
    if (!this.filePath || !existsSync(this.filePath)) return;
    let parsed: MemoryFileShape;
    try {
      parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as MemoryFileShape;
    } catch {
      return; // corrupt/unreadable file: start empty rather than crash
    }
    for (const tier of DURABLE_TIERS) {
      const items = parsed.items?.[tier as "long" | "knowledge"];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (item && typeof item.id === "string") this.tiers[tier].set(item.id, item);
      }
    }
  }

  private save(): void {
    if (!this.filePath) return;
    const data: MemoryFileShape = {
      version: 1,
      items: {
        long: [...this.tiers.long.values()],
        knowledge: [...this.tiers.knowledge.values()],
      },
    };
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* best-effort on platforms without POSIX perms */
    }
  }
}

/** Open a MemoryStore, loading any persisted durable tiers. */
export function openMemory(opts: MemoryStoreOptions = {}): MemoryStore {
  return new MemoryStore(opts);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function clone(item: MemoryItem): MemoryItem {
  return { ...item, ...(item.tags ? { tags: [...item.tags] } : {}) };
}

function byCreatedThenId(a: MemoryItem, b: MemoryItem): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function byScoreThenRecency(a: SearchHit, b: SearchHit): number {
  return (
    b.score - a.score ||
    b.item.updatedAt - a.item.updatedAt ||
    (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0)
  );
}
