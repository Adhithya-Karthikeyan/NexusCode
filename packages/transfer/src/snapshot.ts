/**
 * PnkcSnapshotStore — the ONLY real rollback target.
 *
 * A snapshot captures the CURRENT materialized PNKC state (every `zlcts_items`
 * row regardless of status, all `zlcts_graph_nodes`, all `zlcts_graph_edges`,
 * all `zlcts_summaries`) as one content-addressed JSON blob. The sha256 of the
 * serialized bytes is the checksum stored alongside. `restore` re-materializes
 * the four tables from the blob within a single transaction and truncates WAL
 * rows with lamport_ts > the snapshot's, so the PNKC returns to exactly the
 * snapshotted state. This is what makes "switch providers mid-run, lose
 * nothing" survivable across crashes.
 */

import { createHash } from "node:crypto";
import type { BlobStore } from "./blobs.js";
import type { DbLike } from "./migrate.js";
import { ulid } from "./items.js";
import { createDeltaWAL } from "./wal.js";

/** Reference to a freshly written snapshot. */
export interface SnapshotRef {
  snapshotId: string;
  blobRef: string;
  checksum: string;
  lamportTs: number;
}

/** A stored snapshot row. */
export interface SnapshotRow {
  snapshotId: string;
  sessionId: string;
  lamportTs: number;
  blobRef: string;
  checksum: string;
  createdAt: string;
}

/** The serialized shape of a snapshot blob. */
interface SnapshotBlob {
  items: ItemSnapRow[];
  graphNodes: GraphNodeSnapRow[];
  graphEdges: GraphEdgeSnapRow[];
  summaries: SummarySnapRow[];
}

interface ItemSnapRow {
  id: string;
  kind: string;
  scope: string;
  title: string;
  body: string;
  why_gloss: string | null;
  rationale_json: string | null;
  fields_json: string | null;
  importance: number;
  confidence: number;
  staleness: number;
  status: string;
  revision: number;
  superseded_by: string | null;
  created_at: number;
  updated_at: number;
  last_verified_at: number;
  ttl_ms: number | null;
  tags: string;
  links_json: string;
  embedding_key: string;
  source_json: string;
  verification_json: string | null;
}

interface GraphNodeSnapRow {
  node_id: string;
  version: number;
  type: string;
  label: string | null;
  attrs_json: string | null;
  item_refs_json: string | null;
  created_at: string;
  superseded_by: string | null;
  coverage: string | null;
}

interface GraphEdgeSnapRow {
  edge_id: string;
  version: number;
  from_node: string;
  to_node: string;
  kind: string;
  w: number | null;
  confidence: number | null;
  verified: number;
  attrs_json: string | null;
  created_at: string;
  superseded_by: string | null;
}

interface SummarySnapRow {
  id: string;
  level: number;
  child_ids: string | null;
  text: string;
  span_from: number | null;
  span_to: number | null;
  importance: number | null;
  embedding_key: string | null;
  failures_kept: string | null;
  generated_at: string;
  supersedes: string | null;
}

/** The PnkcSnapshotStore surface. */
export interface PnkcSnapshotStore {
  write(sessionId: string, lamportTs: number): SnapshotRef;
  latest(sessionId: string): SnapshotRow | null;
  list(sessionId: string): SnapshotRow[];
  get(snapshotId: string): SnapshotRow | null;
  restore(snapshotId: string): { lamportTs: number; sessionId: string };
}

/** Create a PnkcSnapshotStore over the given db + blob store. */
export function createPnkcSnapshotStore(db: DbLike, blobs: BlobStore): PnkcSnapshotStore {
  const insSnap = db.prepare(
    `INSERT INTO zlcts_snapshots (snapshot_id, session_id, lamport_ts, blob_ref, checksum, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  return {
    write(sessionId: string, lamportTs: number): SnapshotRef {
      const items = db.prepare(`SELECT * FROM zlcts_items`).all() as ItemSnapRow[];
      const graphNodes = db.prepare(`SELECT * FROM zlcts_graph_nodes`).all() as GraphNodeSnapRow[];
      const graphEdges = db.prepare(`SELECT * FROM zlcts_graph_edges`).all() as GraphEdgeSnapRow[];
      const summaries = db.prepare(`SELECT * FROM zlcts_summaries`).all() as SummarySnapRow[];
      const blob: SnapshotBlob = { items, graphNodes, graphEdges, summaries };
      const jsonBytes = Buffer.from(JSON.stringify(blob), "utf8");
      const checksum = createHash("sha256").update(jsonBytes).digest("hex");
      const blobRef = blobs.put(jsonBytes);
      const snapshotId = `snap_${ulid()}`;
      const createdAt = new Date().toISOString();
      // One transaction: the snapshot row + blob are written together. The blob
      // store is content-addressed and atomic (temp+rename), so it is already
      // durable before the COMMIT; writing it inside the tx is fine.
      db.exec("BEGIN");
      try {
        insSnap.run(snapshotId, sessionId, lamportTs, blobRef, checksum, createdAt);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { snapshotId, blobRef, checksum, lamportTs };
    },

    latest(sessionId: string): SnapshotRow | null {
      const row = db
        .prepare(
          `SELECT snapshot_id, session_id, lamport_ts, blob_ref, checksum, created_at
           FROM zlcts_snapshots WHERE session_id = ?
           ORDER BY lamport_ts DESC, created_at DESC LIMIT 1`,
        )
        .get(sessionId) as SnapshotSnapRow | undefined;
      return row ? toSnapshotRow(row) : null;
    },

    list(sessionId: string): SnapshotRow[] {
      const rows = db
        .prepare(
          `SELECT snapshot_id, session_id, lamport_ts, blob_ref, checksum, created_at
           FROM zlcts_snapshots WHERE session_id = ?
           ORDER BY lamport_ts DESC, created_at DESC`,
        )
        .all(sessionId) as SnapshotSnapRow[];
      return rows.map(toSnapshotRow);
    },

    get(snapshotId: string): SnapshotRow | null {
      const row = db
        .prepare(
          `SELECT snapshot_id, session_id, lamport_ts, blob_ref, checksum, created_at
           FROM zlcts_snapshots WHERE snapshot_id = ?`,
        )
        .get(snapshotId) as SnapshotSnapRow | undefined;
      return row ? toSnapshotRow(row) : null;
    },

    restore(snapshotId: string): { lamportTs: number; sessionId: string } {
      const row = db
        .prepare(
          `SELECT session_id, lamport_ts, blob_ref, checksum FROM zlcts_snapshots WHERE snapshot_id = ?`,
        )
        .get(snapshotId) as
        | { session_id: string; lamport_ts: number; blob_ref: string; checksum: string }
        | undefined;
      if (!row) throw new Error(`snapshot not found: ${snapshotId}`);
      const bytes = blobs.get(row.blob_ref);
      if (!bytes) throw new Error(`snapshot blob missing: ${row.blob_ref}`);
      // Verify the blob's checksum before materializing it. Restore is the
      // rollback target invoked when the WAL is corrupt, so silently
      // materializing a bit-rotted blob would compound corruption. On mismatch
      // throw — `repair` surfaces the error rather than poisoning the PNKC.
      const actualChecksum = createHash("sha256").update(Buffer.from(bytes)).digest("hex");
      if (actualChecksum !== row.checksum) {
        throw new Error(`snapshot corrupted: ${snapshotId}`);
      }
      const blob = JSON.parse(Buffer.from(bytes).toString("utf8")) as SnapshotBlob;

      const wal = createDeltaWAL(db, blobs);
      const delItems = db.prepare(`DELETE FROM zlcts_items`);
      const delNodes = db.prepare(`DELETE FROM zlcts_graph_nodes`);
      const delEdges = db.prepare(`DELETE FROM zlcts_graph_edges`);
      const delSummaries = db.prepare(`DELETE FROM zlcts_summaries`);
      const insItem = db.prepare(
        `INSERT INTO zlcts_items
           (id, kind, scope, title, body, why_gloss, rationale_json, fields_json,
            importance, confidence, staleness, status, revision, superseded_by,
            created_at, updated_at, last_verified_at, ttl_ms, tags, links_json,
            embedding_key, source_json, verification_json, embedding_vector)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      );
      const insNode = db.prepare(
        `INSERT OR REPLACE INTO zlcts_graph_nodes
           (node_id, version, type, label, attrs_json, item_refs_json, created_at, superseded_by, coverage)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insEdge = db.prepare(
        `INSERT OR REPLACE INTO zlcts_graph_edges
           (edge_id, version, from_node, to_node, kind, w, confidence, verified, attrs_json, created_at, superseded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insSummary = db.prepare(
        `INSERT OR REPLACE INTO zlcts_summaries
           (id, level, child_ids, text, span_from, span_to, importance, embedding_key,
            failures_kept, generated_at, supersedes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      db.exec("BEGIN");
      try {
        // FTS external-content triggers fire on DELETE/INSERT and keep the
        // index in sync. zlcts_items has a TEXT PRIMARY KEY and is NOT WITHOUT
        // ROWID, so DELETE/INSERT preserves rowid semantics.
        delItems.run();
        delNodes.run();
        delEdges.run();
        delSummaries.run();
        for (const it of blob.items) {
          insItem.run(
            it.id,
            it.kind,
            it.scope,
            it.title,
            it.body,
            it.why_gloss,
            it.rationale_json,
            it.fields_json,
            it.importance,
            it.confidence,
            it.staleness,
            it.status,
            it.revision,
            it.superseded_by,
            it.created_at,
            it.updated_at,
            it.last_verified_at,
            it.ttl_ms,
            it.tags,
            it.links_json,
            it.embedding_key,
            it.source_json,
            it.verification_json,
          );
        }
        for (const n of blob.graphNodes) {
          insNode.run(
            n.node_id,
            n.version,
            n.type,
            n.label,
            n.attrs_json,
            n.item_refs_json,
            n.created_at,
            n.superseded_by,
            n.coverage,
          );
        }
        for (const e of blob.graphEdges) {
          insEdge.run(
            e.edge_id,
            e.version,
            e.from_node,
            e.to_node,
            e.kind,
            e.w,
            e.confidence,
            e.verified,
            e.attrs_json,
            e.created_at,
            e.superseded_by,
          );
        }
        for (const s of blob.summaries) {
          insSummary.run(
            s.id,
            s.level,
            s.child_ids,
            s.text,
            s.span_from,
            s.span_to,
            s.importance,
            s.embedding_key,
            s.failures_kept,
            s.generated_at,
            s.supersedes,
          );
        }
        // Drop WAL rows that arrived AFTER the snapshot — they would re-fold
        // changes the snapshot already superseded.
        wal.truncate(row.session_id, row.lamport_ts);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { lamportTs: row.lamport_ts, sessionId: row.session_id };
    },
  };
}

interface SnapshotSnapRow {
  snapshot_id: string;
  session_id: string;
  lamport_ts: number;
  blob_ref: string;
  checksum: string;
  created_at: string;
}

function toSnapshotRow(r: SnapshotSnapRow): SnapshotRow {
  return {
    snapshotId: r.snapshot_id,
    sessionId: r.session_id,
    lamportTs: r.lamport_ts,
    blobRef: r.blob_ref,
    checksum: r.checksum,
    createdAt: r.created_at,
  };
}