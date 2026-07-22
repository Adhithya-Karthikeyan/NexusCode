/**
 * VerbatimSink — unredacted chunk copy (`zlcts_verbatim`).
 *
 * The runner calls this BEFORE the existing redacting SessionStore.append so the
 * raw, unredacted chunk survives to the audit log. Encryption-at-rest is deferred
 * to a later phase (encrypted=0 for now).
 */

import { createHash } from "node:crypto";
import type { StreamChunk } from "@nexuscode/shared";
import type { BlobStore } from "./blobs.js";
import type { DbLike } from "./migrate.js";

/** The VerbatimSink surface. */
export interface VerbatimSink {
  write(chunk: StreamChunk, ctx: { sessionId: string; lamportTs: number }): void;
  read(seq: number): { chunkType: string; payload: Uint8Array | null; encrypted: number } | null;
}

/** Create a VerbatimSink. */
export function createVerbatimSink(db: DbLike, blobs: BlobStore): VerbatimSink {
  const ins = db.prepare(
    `INSERT INTO zlcts_verbatim
       (session_id, lamport_ts, chunk_type, payload_ref, checksum, encrypted, written_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`,
  );
  const getRow = db.prepare(
    `SELECT chunk_type, payload_ref, encrypted FROM zlcts_verbatim WHERE seq = ?`,
  );

  return {
    write(chunk, ctx): void {
      const json = JSON.stringify(chunk);
      const bytes = Buffer.from(json, "utf8");
      const checksum = createHash("sha256").update(bytes).digest("hex");
      const payloadRef = blobs.put(json);
      // TODO(Phase 2): encrypt payload at rest; set encrypted=1 and store key id.
      ins.run(
        ctx.sessionId,
        ctx.lamportTs,
        chunk.type,
        payloadRef,
        checksum,
        new Date().toISOString(),
      );
    },
    read(seq) {
      const row = getRow.get(seq) as
        | { chunk_type: string; payload_ref: string; encrypted: number }
        | undefined;
      if (!row) return null;
      return {
        chunkType: row.chunk_type,
        payload: blobs.get(row.payload_ref),
        encrypted: row.encrypted,
      };
    },
  };
}