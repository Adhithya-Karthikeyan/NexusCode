/**
 * Tests for the open-time crash-recovery seam `recoverMindDbOnOpen`.
 *
 * Contract: a crash that leaves WAL rows appended-but-unfolded (`folded=0`)
 * must be recovered on the next open — folded items materialized, rows marked
 * folded. In-memory dbs are skipped. A missing payload blob (corruption) must
 * NOT throw — recovery is non-fatal so it never blocks reads. Idempotent.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateMindDb } from "../src/migrate.js";
import { createBlobStore } from "../src/blobs.js";
import { recoverMindDbOnOpen } from "../src/recover.js";
import type { Delta, EpisodicFields } from "../src/items.js";

interface Db {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...p: unknown[]): unknown;
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
  };
  close(): void;
}

async function openDb(path: string): Promise<Db> {
  const mod = (await import("better-sqlite3")) as unknown as { default: new (p: string) => Db };
  return new mod.default(path);
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "zlcts-recover-open-"));
}

const fields: EpisodicFields = {
  runId: "r1",
  turnId: "t1",
  action: "bash",
  result: "success",
  projectorVersion: 1,
  deltaKids: { added: [], updated: [], invalidated: [] },
  deltaFiles: [],
  tokensIn: 10,
  tokensOut: 20,
};

/** Insert an unfolded execution-event WAL row pointing at a real payload blob. */
function insertUnfolded(db: Db, blobs: ReturnType<typeof createBlobStore>, entityId: string, lamport: number): void {
  const delta: Delta = {
    op: "execution-event",
    sessionId: "s1",
    lamportTs: lamport,
    actionId: `a-${lamport}`,
    entityId,
    title: "t",
    body: "b",
    fields,
  };
  const ref = blobs.put(JSON.stringify(delta));
  db.prepare(
    `INSERT INTO zlcts_wal (session_id, sub_id, lamport_ts, action_id, op_type, entity_type, entity_id, payload_ref, checksum, written_at, durably_written, folded)
     VALUES (?, NULL, ?, ?, 'execution-event', 'item', ?, ?, 'x', ?, 1, 0)`,
  ).run("s1", lamport, `a-${lamport}`, entityId, ref, Date.now());
}

describe("recoverMindDbOnOpen (open-time crash recovery)", () => {
  it("replays unfolded WAL rows left by a crash: item materialized, row folded=1", async () => {
    const dir = tmp();
    try {
      const dbPath = join(dir, "a.db");
      const db = await openDb(dbPath);
      migrateMindDb(db);
      // recoverMindDbOnOpen uses defaultBlobDir(dbPath) = dirname(dbPath) = dir.
      const blobs = createBlobStore(dir);
      insertUnfolded(db, blobs, "e1", 100);
      db.close();

      const db2 = await openDb(dbPath);
      const res = recoverMindDbOnOpen(db2, dbPath);
      expect(res.recovered).toBe(1);
      expect(res.sessions).toEqual(["s1"]);

      const folded = db2.prepare("SELECT folded FROM zlcts_wal WHERE entity_id = 'e1'").get() as { folded: number };
      expect(folded.folded).toBe(1);
      const item = db2.prepare("SELECT id, kind FROM zlcts_items WHERE id = 'e1'").get() as
        | { id: string; kind: string }
        | undefined;
      expect(item).toBeDefined();
      expect(item!.kind).toBe("execution-event");
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips in-memory dbs (nothing to recover, no blob dir)", async () => {
    const db = await openDb(":memory:");
    migrateMindDb(db);
    const res = recoverMindDbOnOpen(db, ":memory:");
    expect(res.recovered).toBe(0);
    db.close();
  });

  it("is non-fatal on a missing payload blob (corruption): does not throw, recovers 0", async () => {
    const dir = tmp();
    try {
      const dbPath = join(dir, "c.db");
      const db = await openDb(dbPath);
      migrateMindDb(db);
      db.prepare(
        `INSERT INTO zlcts_wal (session_id, sub_id, lamport_ts, action_id, op_type, entity_type, entity_id, payload_ref, checksum, written_at, durably_written, folded)
         VALUES (?, NULL, ?, ?, 'execution-event', 'item', ?, 'blob_doesnotexist', 'x', ?, 1, 0)`,
      ).run("s1", 200, "a2", "e2", Date.now());
      db.close();

      const db2 = await openDb(dbPath);
      expect(() => recoverMindDbOnOpen(db2, dbPath)).not.toThrow();
      const res = recoverMindDbOnOpen(db2, dbPath);
      expect(res.recovered).toBe(0);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is idempotent: a second open recovers nothing", async () => {
    const dir = tmp();
    try {
      const dbPath = join(dir, "d.db");
      const db = await openDb(dbPath);
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      insertUnfolded(db, blobs, "e3", 300);
      db.close();

      const db2 = await openDb(dbPath);
      const r1 = recoverMindDbOnOpen(db2, dbPath);
      expect(r1.recovered).toBe(1);
      const r2 = recoverMindDbOnOpen(db2, dbPath);
      expect(r2.recovered).toBe(0);
      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});