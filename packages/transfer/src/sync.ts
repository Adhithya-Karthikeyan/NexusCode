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
        const result = wal.append(entry);
        fold(db, store, delta);
        markFolded.run(result.seq);
        return result;
      });
    },
  };
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