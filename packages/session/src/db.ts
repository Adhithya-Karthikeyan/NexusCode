/**
 * SQLite access for the session package. The event_log + run_summary tables are
 * the single source of truth (owned by `@nexuscode/cli`'s history writer); we
 * open the same database and read them back. Two additive sidecar tables live
 * here — `session_meta` (human-assigned names) and `session_snapshot` (captured
 * points-in-time). They are additive-only: no existing column or table is
 * touched, so the frozen history contract is preserved.
 *
 * `better-sqlite3` is a native module loaded dynamically; if it cannot load we
 * surface a clear error rather than crash the importing process at module load.
 */

import { migrateMindDb, recoverMindDbOnOpen } from "@nexuscode/transfer";

export interface SqliteStmt {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

export interface SqliteDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStmt;
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
  close(): void;
}

/** Base history schema — mirrors `@nexuscode/cli` so a fresh db is usable too. */
const HISTORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS event_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_session ON event_log(session_id, seq);

CREATE TABLE IF NOT EXISTS run_summary (
  run_id        TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  turn_id       TEXT NOT NULL,
  adapter_id    TEXT NOT NULL,
  model         TEXT NOT NULL,
  status        TEXT NOT NULL,
  finish_reason TEXT,
  text          TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd      REAL,
  created_at    INTEGER NOT NULL
);
`;

/** Additive sidecar tables owned by the session package. */
const SESSION_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_meta (
  session_id  TEXT PRIMARY KEY,
  name        TEXT,
  prompt      TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_snapshot (
  snapshot_id TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  label       TEXT,
  up_to_seq   INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshot_session ON session_snapshot(session_id, created_at);
`;

type DbCtor = new (path: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => SqliteDb;

/**
 * Open (or create) the session database, ensuring both the base history schema
 * and the additive session sidecar tables exist. Throws if the native driver is
 * unavailable — callers that must degrade gracefully can catch it.
 */
export async function openSessionDb(dbPath: string): Promise<SqliteDb> {
  let Database: DbCtor;
  try {
    const mod = (await import("better-sqlite3")) as unknown as { default: DbCtor };
    Database = mod.default;
  } catch (err) {
    throw new Error(
      `@nexuscode/session requires better-sqlite3, which failed to load: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(HISTORY_SCHEMA);
  db.exec(SESSION_SCHEMA);
  // ZLCTS knowledge-core tables (additive, idempotent). The frozen history
  // contract is untouched; a failed mind migration must not break session reads.
  try {
    migrateMindDb(db);
  } catch {
    /* best-effort: keep the read side working even if zlcts tables cannot be created */
  }
  // ZLCTS crash-recovery: replay any WAL rows a prior crash left appended-but-
  // unfolded. Safe + idempotent; skips in-memory dbs; non-fatal. Runs after the
  // mind tables exist. Integrity check/repair is deliberately NOT run here (it
  // is on-demand) — see recoverMindDbOnOpen for the rationale.
  try {
    recoverMindDbOnOpen(db, dbPath);
  } catch {
    /* best-effort: never block session reads on recovery failure */
  }
  return db;
}
