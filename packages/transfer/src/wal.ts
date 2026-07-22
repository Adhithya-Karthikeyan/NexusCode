/**
 * DeltaWAL — the append-only durability substrate (`zlcts_wal`).
 *
 * Every capture-path delta is first appended here (with payload in the blob
 * store), then folded into the materialized store. `durably_written` is the S3
 * durability barrier marker (better-sqlite3 is synchronous, so this flag is the
 * simulated fsync). `folded` marks entries already applied to the materialized
 * tables. The mutex is held at the call site (sync.ts), not here.
 */

import { createHash } from "node:crypto";
import type { BlobStore } from "./blobs.js";
import type { DbLike } from "./migrate.js";

/** One WAL entry awaiting append. */
export interface WalEntry {
  sessionId: string;
  subId?: string;
  lamportTs: number;
  actionId: string;
  opType: string;
  entityType: string;
  entityId: string;
  payload: Uint8Array | string;
}

/** Result of appending one entry. */
export interface WalAppendResult {
  seq: number;
  lamportTs: number;
  payloadRef: string;
  checksum: string;
}

/** The DeltaWAL surface. */
export interface DeltaWAL {
  append(entry: WalEntry): WalAppendResult;
  flushSync(sessionId: string, upToLamport: number): void;
  unfolded(sessionId: string): WalEntry[];
  truncate(sessionId: string, upToLamport: number): void;
}

/** Create a DeltaWAL over the given db + blob store. */
export function createDeltaWAL(db: DbLike, blobs: BlobStore): DeltaWAL {
  const insWal = db.prepare(
    `INSERT INTO zlcts_wal
       (session_id, sub_id, lamport_ts, action_id, op_type, entity_type, entity_id,
        payload_ref, checksum, written_at, durably_written, folded)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
  );
  const lastSeqStmt = db.prepare("SELECT last_insert_rowid() AS seq");

  return {
    append(entry: WalEntry): WalAppendResult {
      const bytes =
        typeof entry.payload === "string"
          ? Buffer.from(entry.payload, "utf8")
          : Buffer.from(entry.payload);
      const checksum = createHash("sha256").update(bytes).digest("hex");
      const payloadRef = blobs.put(entry.payload);
      insWal.run(
        entry.sessionId,
        entry.subId ?? null,
        entry.lamportTs,
        entry.actionId,
        entry.opType,
        entry.entityType,
        entry.entityId,
        payloadRef,
        checksum,
        new Date().toISOString(),
      );
      const row = lastSeqStmt.get() as { seq?: number };
      const seq = row.seq ?? 0;
      return { seq, lamportTs: entry.lamportTs, payloadRef, checksum };
    },

    flushSync(sessionId: string, upToLamport: number): void {
      db.prepare(
        `UPDATE zlcts_wal SET durably_written = 1
         WHERE session_id = ? AND lamport_ts <= ? AND durably_written = 0`,
      ).run(sessionId, upToLamport);
    },

    unfolded(sessionId: string): WalEntry[] {
      const rows = db
        .prepare(
          `SELECT session_id, sub_id, lamport_ts, action_id, op_type, entity_type, entity_id, payload_ref
           FROM zlcts_wal WHERE session_id = ? AND folded = 0 ORDER BY lamport_ts ASC, seq ASC`,
        )
        .all(sessionId) as {
        session_id: string;
        sub_id: string | null;
        lamport_ts: number;
        action_id: string;
        op_type: string;
        entity_type: string;
        entity_id: string;
        payload_ref: string;
      }[];
      return rows.map((r) => {
        const e: WalEntry = {
          sessionId: r.session_id,
          lamportTs: r.lamport_ts,
          actionId: r.action_id,
          opType: r.op_type,
          entityType: r.entity_type,
          entityId: r.entity_id,
          payload: r.payload_ref,
        };
        if (r.sub_id !== null) e.subId = r.sub_id;
        return e;
      });
    },

    truncate(sessionId: string, upToLamport: number): void {
      db.prepare(
        `DELETE FROM zlcts_wal WHERE session_id = ? AND lamport_ts > ?`,
      ).run(sessionId, upToLamport);
    },
  };
}