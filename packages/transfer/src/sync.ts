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
      return mutex.run(() => {
        const entry = walEntryFor(delta);
        const result = wal.append(entry);
        fold(db, store, delta);
        markFolded.run(result.seq);
        return result;
      });
    },
  };
}

/** Build the WAL entry for a delta. */
function walEntryFor(delta: Delta): WalEntry {
  switch (delta.op) {
    case "upsert-item": {
      const payload = JSON.stringify(delta.item);
      return {
        sessionId: delta.item.source.ref,
        lamportTs: delta.item.updatedAt,
        actionId: `upsert-${delta.item.id}`,
        opType: "upsert-item",
        entityType: "item",
        entityId: delta.item.id,
        payload,
      };
    }
    case "supersede-item":
      return {
        sessionId: delta.sessionId,
        lamportTs: Date.now(),
        actionId: `supersede-${delta.id}`,
        opType: "supersede-item",
        entityType: "item",
        entityId: delta.id,
        payload: JSON.stringify({ id: delta.id, byId: delta.byId }),
      };
    case "put-node":
      return {
        sessionId: delta.sessionId,
        lamportTs: Date.now(),
        actionId: `put-node-${delta.node.id}`,
        opType: "put-node",
        entityType: "node",
        entityId: delta.node.id,
        payload: JSON.stringify(delta.node),
      };
    case "put-edge":
      return {
        sessionId: delta.sessionId,
        lamportTs: Date.now(),
        actionId: `put-edge-${delta.edge.edgeId}`,
        opType: "put-edge",
        entityType: "edge",
        entityId: delta.edge.edgeId,
        payload: JSON.stringify(delta.edge),
      };
    case "execution-event":
      return {
        sessionId: delta.sessionId,
        subId: delta.subId,
        lamportTs: delta.lamportTs,
        actionId: delta.actionId,
        opType: "execution-event",
        entityType: "item",
        entityId: delta.entityId,
        payload: JSON.stringify(delta.fields),
      };
    case "capture":
      return {
        sessionId: delta.sessionId,
        subId: delta.subId,
        lamportTs: delta.lamportTs,
        actionId: `capture-${delta.lamportTs}`,
        opType: "capture",
        entityType: "raw",
        entityId: `${delta.sessionId}-${delta.lamportTs}`,
        payload: delta.payload,
      };
    case "handoff":
      return {
        sessionId: delta.sessionId,
        subId: delta.subId,
        lamportTs: delta.lamportTs,
        actionId: `handoff-${delta.lamportTs}`,
        opType: "handoff",
        entityType: "handoff",
        entityId: `${delta.sessionId}-${delta.lamportTs}`,
        payload: JSON.stringify({
          fromProvider: delta.fromProvider,
          toProvider: delta.toProvider,
          reason: delta.reason,
        }),
      };
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
      const item = buildExecutionEventItem(db, delta.entityId, delta.title, delta.body, delta.fields);
      store.put(item);
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
  db: DbLike,
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
  // Persist the EpisodicFields as fields_json via a direct update — the store's
  // `put` does not currently expose a fields parameter, so we write the column
  // after the upsert. This keeps the fold atomic from the caller's view.
  store_putFields(db, item.id, fields);
  return item;
}

/** Low-level fields_json write (used by the execution-event fold). */
function store_putFields(db: DbLike, id: string, fields: EpisodicFields): void {
  db.prepare(`UPDATE zlcts_items SET fields_json = ? WHERE id = ?`).run(
    JSON.stringify(fields),
    id,
  );
}