/**
 * DeltaSyncBus — the fold point.
 *
 * `apply(delta)` validates a delta, routes through the SessionDb write mutex,
 * appends it to the DeltaWAL (payload -> blob store), then FOLDS it into the
 * materialized store and marks the WAL row `folded=1`. capture/handoff deltas
 * are WAL-only (no materialized item).
 */

import type { BlobStore } from "./blobs.js";
import type { Delta } from "./deltas.js";
import type { EpisodicFields, KnowledgeItem } from "./items.js";
import { makeEmbeddingKey, ulid } from "./items.js";
import type { ItemStore } from "./store.js";
import { createItemStore } from "./store.js";
import type { Mutex } from "./mutex.js";
import type { DbLike } from "./migrate.js";
import type { WalAppendResult, WalEntry } from "./wal.js";
import { createDeltaWAL } from "./wal.js";

/** The DeltaSyncBus surface. */
export interface DeltaSyncBus {
  apply(delta: Delta): Promise<WalAppendResult>;
}

/** Create a DeltaSyncBus bound to db + blobs + mutex. */
export function createDeltaSyncBus(db: DbLike, blobs: BlobStore, mutex: Mutex): DeltaSyncBus {
  const wal = createDeltaWAL(db, blobs);
  const store = createItemStore(db);
  const markFolded = db.prepare(`UPDATE zlcts_wal SET folded = 1 WHERE seq = ?`);

  return {
    async apply(delta: Delta): Promise<WalAppendResult> {
      return mutex.run(async () => {
        const entry = walEntryFor(delta);
        // Atomic fold: wal.append + fold + markFolded run in one better-sqlite3
        // transaction so a crash between them leaves no partial state (a WAL
        // row without its materialized item, or an item without a folded row).
        // On fold throwing, ROLLBACK and rethrow; the mutex tail stays alive
        // (`tail.catch(()=>undefined)` in createMutex keeps the chain going).
        db.exec("BEGIN");
        try {
          const result = wal.append(entry);
          fold(db, store, delta);
          markFolded.run(result.seq);
          db.exec("COMMIT");
          return result;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      });
    },
  };
}

/**
 * Reconstruct a {@link Delta} from a {@link WalEntry} and re-fold it into the
 * materialized store. Used by {@link recoverUnfolded} at startup (before any
 * live writer) to replay deltas whose `folded` flag is still 0 (a crash left
 * them appended-but-unfolded). NOT routed through the mutex by default —
 * recovery runs at startup before live writers exist. Callers MAY acquire the
 * mutex if a live writer could exist. After refold, the matching WAL row is
 * marked `folded=1`. Idempotent: re-folding an already-folded row is a no-op
 * (the materialized row is already present and non-overwrite keeps it).
 *
 * The WalEntry must carry the FULL serialized delta as its payload (the
 * contract enforced by {@link walEntryFor}). For recovery from a raw WAL row,
 * `payload` may be either the blob ref (string) returned by `wal.unfolded`, or
 * the already-loaded delta bytes — `refold` resolves a string ref via the blob
 * store, then JSON.parses to a Delta.
 */
export function refold(db: DbLike, blobs: BlobStore, entry: WalEntry, seq?: number): void {
  const bytes = blobs.get(typeof entry.payload === "string" ? entry.payload : "");
  if (!bytes) {
    throw new Error(`refold: payload blob missing for entity ${entry.entityId}`);
  }
  const delta = JSON.parse(Buffer.from(bytes).toString("utf8")) as Delta;
  const store = createItemStore(db);
  fold(db, store, delta);
  // Mark the matching WAL row folded. When `seq` is provided (the
  // `recoverUnfolded` path, which SELECTs seq), mark by the precise primary
  // key — two deltas can share (session_id, lamport_ts, op_type, entity_id)
  // and the composite-key UPDATE would mark an unrelated row folded=1. When
  // `seq` is undefined (a direct `refold` call without a WAL row), fall back
  // to the composite-key UPDATE for backward compatibility.
  if (seq !== undefined) {
    db.prepare(`UPDATE zlcts_wal SET folded = 1 WHERE seq = ?`).run(seq);
  } else {
    db.prepare(
      `UPDATE zlcts_wal SET folded = 1
       WHERE session_id = ? AND lamport_ts = ? AND op_type = ? AND entity_id = ? AND folded = 0`,
    ).run(entry.sessionId, entry.lamportTs, entry.opType, entry.entityId);
  }
}

/**
 * Replay every unfolded WAL row (folded=0) for ALL sessions, in lamport-then-seq
 * order. Returns the count of rows recovered, the count that failed (a missing
 * or corrupt payload blob for one row does NOT abort recovery — the row is left
 * `folded=0` and the next row is attempted), and the distinct session ids
 * touched (including sessions of failed rows). Idempotent: a second call finds
 * folded=0 rows only for deltas that failed to refold. Runs under the mutex
 * when one is supplied so a live writer cannot interleave.
 */
export function recoverUnfolded(
  db: DbLike,
  blobs: BlobStore,
  mutex: Mutex,
): { recovered: number; failed: number; sessions: string[] } {
  return mutex.runSync(() => {
    const rows = db
      .prepare(
        `SELECT seq, session_id, sub_id, lamport_ts, action_id, op_type, entity_type, entity_id, payload_ref
         FROM zlcts_wal WHERE folded = 0 ORDER BY lamport_ts ASC, seq ASC`,
      )
      .all() as {
      seq: number;
      session_id: string;
      sub_id: string | null;
      lamport_ts: number;
      action_id: string;
      op_type: string;
      entity_type: string;
      entity_id: string;
      payload_ref: string;
    }[];
    const sessions = new Set<string>();
    let recovered = 0;
    let failed = 0;
    for (const r of rows) {
      const entry: WalEntry = {
        sessionId: r.session_id,
        lamportTs: r.lamport_ts,
        actionId: r.action_id,
        opType: r.op_type,
        entityType: r.entity_type,
        entityId: r.entity_id,
        payload: r.payload_ref,
      };
      if (r.sub_id !== null) entry.subId = r.sub_id;
      try {
        refold(db, blobs, entry, r.seq);
        sessions.add(r.session_id);
        recovered++;
      } catch {
        // A missing/corrupt blob for one row must not abort recovery of the
        // rest. Leave this row `folded=0` (it already is) and continue. The
        // session is still counted as touched.
        sessions.add(r.session_id);
        failed++;
        continue;
      }
    }
    return { recovered, failed, sessions: [...sessions] };
  });
}

/**
 * Build the WAL entry for a delta.
 *
 * CRITICAL CONTRACT: the payload is the FULL serialized delta (the entire Delta
 * object including `op`). A WAL row's payload blob is therefore a complete,
 * replayable delta — `refold` parses it back to a Delta and routes it through
 * `fold`. Storing sub-fields only (item / fields / node / edge) loses the
 * surrounding delta shape and made recovery impossible (reviewer finding #3).
 *
 * `lamportTs`/`sessionId`/`subId` are pulled from the delta where available so
 * the WAL row's indexed columns match the payload; upsert-item derives them
 * from the item itself (no explicit sessionId on that variant).
 */
function walEntryFor(delta: Delta): WalEntry {
  const payload = JSON.stringify(delta);
  switch (delta.op) {
    case "upsert-item":
      return {
        sessionId: delta.item.source.ref,
        lamportTs: delta.item.updatedAt,
        actionId: `upsert-${delta.item.id}`,
        opType: "upsert-item",
        entityType: "item",
        entityId: delta.item.id,
        payload,
      };
    case "supersede-item":
      return {
        sessionId: delta.sessionId,
        lamportTs: Date.now(),
        actionId: `supersede-${delta.id}`,
        opType: "supersede-item",
        entityType: "item",
        entityId: delta.id,
        payload,
      };
    case "put-node":
      return {
        sessionId: delta.sessionId,
        lamportTs: Date.now(),
        actionId: `put-node-${delta.node.id}`,
        opType: "put-node",
        entityType: "node",
        entityId: delta.node.id,
        payload,
      };
    case "put-edge":
      return {
        sessionId: delta.sessionId,
        lamportTs: Date.now(),
        actionId: `put-edge-${delta.edge.edgeId}`,
        opType: "put-edge",
        entityType: "edge",
        entityId: delta.edge.edgeId,
        payload,
      };
    case "execution-event": {
      const e: WalEntry = {
        sessionId: delta.sessionId,
        lamportTs: delta.lamportTs,
        actionId: delta.actionId,
        opType: "execution-event",
        entityType: "item",
        entityId: delta.entityId,
        payload,
      };
      if (delta.subId !== undefined) e.subId = delta.subId;
      return e;
    }
    case "capture": {
      const e: WalEntry = {
        sessionId: delta.sessionId,
        lamportTs: delta.lamportTs,
        actionId: `capture-${delta.lamportTs}`,
        opType: "capture",
        entityType: "raw",
        entityId: `${delta.sessionId}-${delta.lamportTs}`,
        payload,
      };
      if (delta.subId !== undefined) e.subId = delta.subId;
      return e;
    }
    case "handoff": {
      const e: WalEntry = {
        sessionId: delta.sessionId,
        lamportTs: delta.lamportTs,
        actionId: `handoff-${delta.lamportTs}`,
        opType: "handoff",
        entityType: "handoff",
        entityId: `${delta.sessionId}-${delta.lamportTs}`,
        payload,
      };
      if (delta.subId !== undefined) e.subId = delta.subId;
      return e;
    }
  }
}

/** Fold a delta into the materialized store. */
function fold(db: DbLike, store: ItemStore, delta: Delta): void {
  switch (delta.op) {
    case "upsert-item":
      store.put(delta.item);
      return;
    case "supersede-item":
      store.supersede(delta.id, delta.byId);
      return;
    case "put-node":
      store.putNode(delta.node);
      return;
    case "put-edge":
      store.putEdge(delta.edge);
      return;
    case "execution-event": {
      const item = buildExecutionEventItem(delta.entityId, delta.title, delta.body, delta.fields);
      store.put(item);
      // Persist the EpisodicFields as fields_json after the row exists.
      store_putFields(db, item.id, delta.fields);
      return;
    }
    case "capture":
    case "handoff":
      // WAL-only; no materialized item.
      return;
  }
}

/** Build an execution-event KnowledgeItem from EpisodicFields. */
function buildExecutionEventItem(
  id: string,
  title: string,
  body: string,
  fields: EpisodicFields,
): KnowledgeItem {
  const now = Date.now();
  const item: KnowledgeItem = {
    id: id || ulid(now),
    kind: "execution-event",
    scope: "session",
    title,
    body,
    importance: 0.3,
    confidence: 0.7,
    staleness: 0,
    status: "active",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    lastVerifiedAt: now,
    links: [],
    tags: [`result:${fields.result}`, `action:${fields.action}`],
    embeddingKey: makeEmbeddingKey({ title, body, tags: [`result:${fields.result}`] }),
    source: { origin: "provider", ref: fields.runId },
  };
  return item;
}

/** Low-level fields_json write (used by the execution-event fold, after put). */
function store_putFields(db: DbLike, id: string, fields: EpisodicFields): void {
  db.prepare(`UPDATE zlcts_items SET fields_json = ? WHERE id = ?`).run(
    JSON.stringify(fields),
    id,
  );
}