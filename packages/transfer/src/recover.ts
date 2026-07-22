/**
 * Crash-recovery replay on session-db open.
 *
 * The single safe, idempotent recovery action to run every time the shared
 * history db is opened: replay any WAL rows a crash left appended-but-unfolded
 * (`folded = 0`). `recoverUnfolded` re-folds them via {@link refold} and marks
 * each row folded, in lamport-then-seq order, under the write mutex.
 *
 * IMPORTANT — what this does NOT do: it deliberately does NOT call
 * `IntegrityRepair.check`/`repair` on every open. `repair` only persists the
 * `stableHash` baseline when it runs; on a clean open where deltas folded
 * normally since the last repair, that baseline is stale, so `check` would
 * report `hashChanged = true` and `repair` would restore an older snapshot +
 * record a spurious `DataLoss` event — real data loss, triggered by a healthy
 * db. Integrity check/repair is therefore an on-demand facility (manual /
 * `nexus context --integrity`), not an open-time side effect.
 *
 * Non-fatal: any error is swallowed so a corrupt WAL or missing blob never
 * blocks the read side. In-memory dbs (`:memory:`) are skipped — there is
 * nothing to recover and no blob dir to read.
 */

import { dirname } from "node:path";
import type { BlobStore } from "./blobs.js";
import { createBlobStore } from "./blobs.js";
import type { DbLike } from "./migrate.js";
import { createMutex } from "./mutex.js";
import { recoverUnfolded } from "./sync.js";

/**
 * Canonical blob-store directory for a session db path. The directory the
 * {@link createTransferHandle} call (Phase 4) MUST use for the same db so that
 * open-time recovery reads the exact blobs the capture path wrote — otherwise
 * WAL payloads would resolve to `null` and recovery would silently skip them.
 */
export function defaultBlobDir(dbPath: string): string {
  return dirname(dbPath);
}

/**
 * Build the canonical blob store for a session db path (creates the directory).
 * Exposed so the Phase 4 handle constructor uses the same store as recovery.
 */
export function createSessionBlobStore(dbPath: string): BlobStore {
  return createBlobStore(defaultBlobDir(dbPath));
}

/**
 * Replay unfolded WAL rows against the canonical blob dir. Safe to call on
 * every open. Returns the count of rows recovered, the count that failed
 * (missing/corrupt payload blob — left folded=0, non-fatal), and the sessions
 * touched, or `{ recovered: 0, failed: 0, sessions: [] }` if skipped
 * (in-memory db) or if recovery threw (non-fatal). Never throws.
 */
export function recoverMindDbOnOpen(db: DbLike, dbPath: string): {
  recovered: number;
  failed: number;
  sessions: string[];
} {
  if (!dbPath || dbPath === ":memory:") return { recovered: 0, failed: 0, sessions: [] };
  try {
    const blobs = createSessionBlobStore(dbPath);
    return recoverUnfolded(db, blobs, createMutex());
  } catch {
    return { recovered: 0, failed: 0, sessions: [] };
  }
}