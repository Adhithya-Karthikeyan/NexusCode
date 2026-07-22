/**
 * ToolProgress — debounced partial tool stdout (`zlcts_tool_progress`).
 *
 * One row per (session, turn, tool). Each append writes the accumulated stdout
 * to the blob store and updates `partial_output_ref` on that row, so the latest
 * partial output always survives a mid-tool-call termination.
 */

import type { BlobStore } from "./blobs.js";
import type { DbLike } from "./migrate.js";

/** The ToolProgress surface. */
export interface ToolProgress {
  append(chunk: { sessionId: string; turnId: string; tool: string; stdout: string }): void;
  readLatest(sessionId: string, turnId: string, tool: string): string | null;
}

/** Create a ToolProgress. */
export function createToolProgress(db: DbLike, blobs: BlobStore): ToolProgress {
  const findRow = db.prepare(
    `SELECT seq, partial_output_ref FROM zlcts_tool_progress
     WHERE session_id = ? AND turn_id = ? AND tool = ? ORDER BY seq DESC LIMIT 1`,
  );
  const ins = db.prepare(
    `INSERT INTO zlcts_tool_progress
       (session_id, turn_id, tool, partial_output_ref, written_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const upd = db.prepare(
    `UPDATE zlcts_tool_progress SET partial_output_ref = ?, written_at = ?
     WHERE seq = ?`,
  );

  return {
    append(chunk) {
      const ref = blobs.put(chunk.stdout);
      const existing = findRow.get(chunk.sessionId, chunk.turnId, chunk.tool) as
        | { seq: number; partial_output_ref: string }
        | undefined;
      const now = new Date().toISOString();
      if (existing) {
        upd.run(ref, now, existing.seq);
      } else {
        ins.run(chunk.sessionId, chunk.turnId, chunk.tool, ref, now);
      }
    },
    readLatest(sessionId, turnId, tool) {
      const row = findRow.get(sessionId, turnId, tool) as
        | { seq: number; partial_output_ref: string }
        | undefined;
      if (!row) return null;
      const bytes = blobs.get(row.partial_output_ref);
      if (!bytes) return null;
      return Buffer.from(bytes).toString("utf8");
    },
  };
}