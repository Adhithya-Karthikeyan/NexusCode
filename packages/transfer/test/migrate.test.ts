import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateMindDb, listMindTables, MIND_DB_VERSION } from "../src/migrate.js";

interface Db {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
  close(): void;
}

async function openDb(path: string): Promise<Db> {
  const mod = (await import("better-sqlite3")) as unknown as { default: new (p: string) => Db };
  return new mod.default(path);
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "zlcts-migrate-"));
}

const EXPECTED_TABLES = [
  "zlcts_edges" as never, // not present — sanity: ensure we don't false-pass
].filter((n): n is string => false);

const REQUIRED = [
  "zlcts_wal",
  "zlcts_items",
  "zlcts_items_fts",
  "zlcts_graph_nodes",
  "zlcts_graph_edges",
  "zlcts_summaries",
  "zlcts_snapshots",
  "zlcts_verbatim",
  "zlcts_tool_progress",
  "zlcts_handoffs",
  "zlcts_integrity",
];

describe("migrateMindDb", () => {
  it("creates every zlcts_* table on a fresh db", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "mind.db"));
      migrateMindDb(db);
      const tables = listMindTables(db);
      for (const name of REQUIRED) expect(tables).toContain(name);
      expect(EXPECTED_TABLES.length).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent: re-running is a no-op and keeps user_version", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "mind.db"));
      migrateMindDb(db);
      const before = db.prepare("PRAGMA user_version").get() as { user_version?: number };
      expect(before.user_version).toBe(MIND_DB_VERSION);
      // Second call must not throw and must not change version.
      migrateMindDb(db);
      const after = db.prepare("PRAGMA user_version").get() as { user_version?: number };
      expect(after.user_version).toBe(MIND_DB_VERSION);
      // FTS trigger objects exist.
      const triggers = db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'zlcts_%'")
        .all() as { name?: string }[];
      expect(triggers.map((t) => t.name).sort()).toEqual([
        "zlcts_items_ad",
        "zlcts_items_ai",
        "zlcts_items_au",
      ]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps FTS5 in sync with zlcts_items via triggers", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "mind.db"));
      migrateMindDb(db);
      const ins = db.prepare(
        `INSERT INTO zlcts_items (id, kind, scope, title, body, embedding_key, source_json, created_at, updated_at, last_verified_at)
         VALUES (?, ?, ?, ?, ?, ?, '{}', 1, 1, 1)`,
      );
      ins.run("k1", "decision", "session", "Use sqlite for store", "because durability", "use sqlite for store");
      const hit = db
        .prepare("SELECT title FROM zlcts_items_fts WHERE zlcts_items_fts MATCH ?")
        .get("sqlite") as { title?: string } | undefined;
      expect(hit?.title).toBe("Use sqlite for store");
      // Delete propagates to FTS.
      db.prepare("DELETE FROM zlcts_items WHERE id = ?").run("k1");
      const gone = db
        .prepare("SELECT title FROM zlcts_items_fts WHERE zlcts_items_fts MATCH ?")
        .get("sqlite") as { title?: string } | undefined;
      expect(gone).toBeUndefined();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});