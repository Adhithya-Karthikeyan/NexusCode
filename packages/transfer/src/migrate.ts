/**
 * @nexuscode/transfer — schema migration for the Zero-Loss Context Transfer
 * System (ZLCTS).
 *
 * The Provider-Neutral Knowledge Core (PNKC) lives in a set of `zlcts_*` tables
 * sidecar to the existing `event_log` / `run_summary` / `turn_message` in the
 * shared history db. Every statement is additive (`CREATE ... IF NOT EXISTS`),
 * so migrating an existing db is a no-op and a fresh db is fully migrated in one
 * call. A `PRAGMA user_version` gate skips the work entirely when the db is
 * already at the target version.
 *
 * The db handle is accepted as a structural {@link DbLike} (exec + prepare) so
 * this package never build-couples to `better-sqlite3` or to `@nexuscode/session`
 * — both the CLI history writer and the session read-side opener can call it
 * with their own db handle.
 */

/** Minimal structural view of a SQLite db handle (better-sqlite3 compatible). */
export interface DbLike {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/** Bump when the schema changes; `migrateMindDb` re-runs only below this version. */
export const MIND_DB_VERSION = 1;

/**
 * The full ZLCTS schema. Ordered so independent tables/indices/triggers are all
 * `IF NOT EXISTS` — safe to exec in full every migration.
 *
 * Tables:
 *  - zlcts_wal           append-only delta log (the durability substrate)
 *  - zlcts_items         materialized KnowledgeItems (single source of truth)
 *  - zlcts_items_fts     FTS5 over items (external-content, sync'd by triggers)
 *  - zlcts_graph_nodes   versioned knowledge-graph nodes
 *  - zlcts_graph_edges   versioned knowledge-graph edges
 *  - zlcts_summaries     hierarchical summaries (level 0-3; failuresKept immortal)
 *  - zlcts_snapshots     PNKC snapshots (the ONLY real rollback target)
 *  - zlcts_verbatim      unredacted, encrypted-at-rest chunk copy
 *  - zlcts_tool_progress debounced partial tool stdout (mid-tool-call termination)
 *  - zlcts_handoffs      handoff package metadata
 *  - zlcts_integrity     KV (stableHash, maintainedHash, ChainOriginManifest, loss)
 */
const MIND_SCHEMA = `
CREATE TABLE IF NOT EXISTS zlcts_wal (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id      TEXT NOT NULL,
  sub_id          TEXT,
  lamport_ts      INTEGER NOT NULL,
  action_id       TEXT NOT NULL,
  op_type         TEXT NOT NULL,
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  payload_ref     TEXT NOT NULL,
  checksum        TEXT NOT NULL,
  written_at      TEXT NOT NULL,
  durably_written INTEGER NOT NULL DEFAULT 0,
  folded          INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_zlcts_wal_session ON zlcts_wal(session_id, lamport_ts);
CREATE INDEX IF NOT EXISTS idx_zlcts_wal_unfolded ON zlcts_wal(session_id) WHERE folded = 0;

CREATE TABLE IF NOT EXISTS zlcts_items (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  scope             TEXT NOT NULL,
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  why_gloss         TEXT,
  rationale_json    TEXT,
  fields_json       TEXT,
  importance        REAL NOT NULL DEFAULT 0.5,
  confidence        REAL NOT NULL DEFAULT 0.5,
  staleness         REAL NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active',
  revision          INTEGER NOT NULL DEFAULT 1,
  superseded_by     TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_verified_at  INTEGER NOT NULL,
  ttl_ms            INTEGER,
  tags              TEXT NOT NULL DEFAULT '[]',
  links_json        TEXT NOT NULL DEFAULT '[]',
  embedding_key     TEXT NOT NULL,
  source_json       TEXT NOT NULL,
  verification_json TEXT,
  embedding_vector  BLOB
);
CREATE INDEX IF NOT EXISTS idx_zlcts_items_kind_scope ON zlcts_items(kind, scope);
CREATE INDEX IF NOT EXISTS idx_zlcts_items_status_imp ON zlcts_items(status, importance DESC);

-- External-content FTS5: the index stores no copies; the triggers below keep it
-- in sync with zlcts_items. content_rowid='rowid' keys FTS rows to the implicit
-- rowid of zlcts_items (which has a TEXT PRIMARY KEY but is NOT WITHOUT ROWID).
CREATE VIRTUAL TABLE IF NOT EXISTS zlcts_items_fts USING fts5(
  title, body, embedding_key,
  content='zlcts_items', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS zlcts_items_ai AFTER INSERT ON zlcts_items BEGIN
  INSERT INTO zlcts_items_fts(rowid, title, body, embedding_key)
  VALUES (new.rowid, new.title, new.body, new.embedding_key);
END;
CREATE TRIGGER IF NOT EXISTS zlcts_items_ad AFTER DELETE ON zlcts_items BEGIN
  INSERT INTO zlcts_items_fts(zlcts_items_fts, rowid, title, body, embedding_key)
  VALUES ('delete', old.rowid, old.title, old.body, old.embedding_key);
END;
CREATE TRIGGER IF NOT EXISTS zlcts_items_au AFTER UPDATE ON zlcts_items BEGIN
  INSERT INTO zlcts_items_fts(zlcts_items_fts, rowid, title, body, embedding_key)
  VALUES ('delete', old.rowid, old.title, old.body, old.embedding_key);
  INSERT INTO zlcts_items_fts(rowid, title, body, embedding_key)
  VALUES (new.rowid, new.title, new.body, new.embedding_key);
END;

CREATE TABLE IF NOT EXISTS zlcts_graph_nodes (
  node_id        TEXT NOT NULL,
  version        INTEGER NOT NULL,
  type           TEXT NOT NULL,
  label          TEXT,
  attrs_json     TEXT,
  item_refs_json TEXT,
  created_at     TEXT NOT NULL,
  superseded_by  TEXT,
  coverage       TEXT DEFAULT 'full',
  PRIMARY KEY (node_id, version)
);

CREATE TABLE IF NOT EXISTS zlcts_graph_edges (
  edge_id       TEXT NOT NULL,
  version       INTEGER NOT NULL,
  from_node     TEXT NOT NULL,
  to_node       TEXT NOT NULL,
  kind          TEXT NOT NULL,
  w             REAL,
  confidence    REAL,
  verified      INTEGER,
  attrs_json    TEXT,
  created_at    TEXT NOT NULL,
  superseded_by TEXT,
  PRIMARY KEY (edge_id, version)
);
CREATE INDEX IF NOT EXISTS idx_zlcts_edges_from ON zlcts_graph_edges(from_node, kind) WHERE superseded_by IS NULL;
CREATE INDEX IF NOT EXISTS idx_zlcts_edges_to ON zlcts_graph_edges(to_node, kind) WHERE superseded_by IS NULL;

CREATE TABLE IF NOT EXISTS zlcts_summaries (
  id            TEXT PRIMARY KEY,
  level         INTEGER NOT NULL,
  child_ids     TEXT,
  text          TEXT NOT NULL,
  span_from     INTEGER,
  span_to       INTEGER,
  importance    REAL,
  embedding_key TEXT,
  failures_kept TEXT,
  generated_at  TEXT NOT NULL,
  supersedes    TEXT
);

CREATE TABLE IF NOT EXISTS zlcts_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  lamport_ts  INTEGER NOT NULL,
  blob_ref    TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_zlcts_snap_session ON zlcts_snapshots(session_id, lamport_ts);

CREATE TABLE IF NOT EXISTS zlcts_verbatim (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  lamport_ts  INTEGER NOT NULL,
  chunk_type  TEXT NOT NULL,
  payload_ref TEXT NOT NULL,
  checksum    TEXT NOT NULL,
  encrypted   INTEGER NOT NULL DEFAULT 0,
  written_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zlcts_tool_progress (
  seq                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT NOT NULL,
  turn_id            TEXT NOT NULL,
  tool               TEXT NOT NULL,
  partial_output_ref TEXT NOT NULL,
  written_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zlcts_handoffs (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  from_provider TEXT NOT NULL,
  to_provider   TEXT NOT NULL,
  reason        TEXT NOT NULL,
  manifest_ref  TEXT NOT NULL,
  checksum      TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  state         TEXT NOT NULL,
  handoff_mode  TEXT NOT NULL DEFAULT 'full'
);

CREATE TABLE IF NOT EXISTS zlcts_integrity (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

/**
 * Migrate the given db to {@link MIND_DB_VERSION}. Idempotent: reads
 * `PRAGMA user_version` and returns immediately if already at target. All schema
 * statements are `IF NOT EXISTS`, so a partial/interrupted migration is safe to
 * re-run. `PRAGMA user_version` is set outside any transaction (SQLite disallows
 * it inside one).
 */
export function migrateMindDb(db: DbLike): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  const current = row?.user_version ?? 0;
  if (current >= MIND_DB_VERSION) return;
  db.exec(MIND_SCHEMA);
  db.exec(`PRAGMA user_version = ${MIND_DB_VERSION};`);
}

/** Test helper: list the zlcts_* tables present (used by migration tests). */
export function listMindTables(db: DbLike): string[] {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'zlcts_%' ORDER BY name")
    .all() as { name?: string }[];
  return rows.map((r) => r.name ?? "");
}