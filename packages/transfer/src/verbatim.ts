/**
 * VerbatimSink — unredacted chunk copy (`zlcts_verbatim`).
 *
 * The runner calls this BEFORE the existing redacting SessionStore.append so the
 * raw, unredacted chunk survives to the audit log. The production runtime uses
 * an encrypted BlobStore; plaintext stores remain available only for isolated
 * tests/backward-compatible embedding.
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
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
      ins.run(
        ctx.sessionId,
        ctx.lamportTs,
        chunk.type,
        payloadRef,
        checksum,
        blobs.encrypted ? 1 : 0,
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
