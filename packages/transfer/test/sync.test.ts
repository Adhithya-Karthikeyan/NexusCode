import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateMindDb } from "../src/migrate.js";
import { createBlobStore } from "../src/blobs.js";
import { createMutex } from "../src/mutex.js";
import { createDeltaSyncBus } from "../src/sync.js";
import { makeEmbeddingKey, ulid, type KnowledgeItem, type EpisodicFields } from "../src/items.js";

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
  return mkdtempSync(join(tmpdir(), "zlcts-sync-"));
}

function item(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  const id = overrides.id ?? ulid();
  const title = overrides.title ?? "Decision";
  const body = overrides.body ?? "body";
  return {
    id,
    kind: "decision",
    scope: "session",
    title,
    body,
    importance: 0.5,
    confidence: 0.5,
    staleness: 0,
    status: "active",
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    lastVerifiedAt: 100,
    links: [],
    tags: [],
    embeddingKey: makeEmbeddingKey({ title, body }),
    source: { origin: "user", ref: "s1" },
    ...overrides,
  };
}

describe("DeltaSyncBus", () => {
  it("apply upsert-item → row in zlcts_items + WAL folded=1", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "sync.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sync = createDeltaSyncBus(db, blobs, createMutex());
      const it = item({ id: "u1" });
      await sync.apply({ op: "upsert-item", item: it });
      const itemRow = db.prepare("SELECT id FROM zlcts_items WHERE id = 'u1'").get();
      expect(itemRow).toBeDefined();
      const walRow = db.prepare("SELECT folded FROM zlcts_wal WHERE seq = 1").get() as {
        folded: number;
      };
      expect(walRow.folded).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("apply execution-event → item created", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "sync.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sync = createDeltaSyncBus(db, blobs, createMutex());
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
      await sync.apply({
        op: "execution-event",
        sessionId: "s1",
        lamportTs: 5,
        actionId: "bash-5",
        entityId: "ee1",
        title: "Ran bash",
        body: "bash succeeded",
        fields,
      });
      const row = db.prepare("SELECT kind, fields_json FROM zlcts_items WHERE id = 'ee1'").get() as {
        kind: string;
        fields_json: string | null;
      };
      expect(row.kind).toBe("execution-event");
      expect(row.fields_json).not.toBeNull();
      const parsed = JSON.parse(row.fields_json!) as EpisodicFields;
      expect(parsed.action).toBe("bash");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supersede → status flips", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "sync.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sync = createDeltaSyncBus(db, blobs, createMutex());
      await sync.apply({ op: "upsert-item", item: item({ id: "su1" }) });
      await sync.apply({ op: "supersede-item", id: "su1", byId: "su2", sessionId: "s1" });
      const row = db.prepare("SELECT status, superseded_by FROM zlcts_items WHERE id = 'su1'").get() as {
        status: string;
        superseded_by: string | null;
      };
      expect(row.status).toBe("superseded");
      expect(row.superseded_by).toBe("su2");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serialized via mutex: two concurrent applies don't corrupt", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "sync.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sync = createDeltaSyncBus(db, blobs, createMutex());
      await Promise.all([
        sync.apply({ op: "upsert-item", item: item({ id: "c1" }) }),
        sync.apply({ op: "upsert-item", item: item({ id: "c2" }) }),
      ]);
      const c1 = db.prepare("SELECT id FROM zlcts_items WHERE id = 'c1'").get();
      const c2 = db.prepare("SELECT id FROM zlcts_items WHERE id = 'c2'").get();
      expect(c1).toBeDefined();
      expect(c2).toBeDefined();
      const walCount = db.prepare("SELECT COUNT(*) AS n FROM zlcts_wal").get() as { n: number };
      expect(walCount.n).toBe(2);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("WAL payload stores the FULL delta (round-trips back to the delta)", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "sync.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sync = createDeltaSyncBus(db, blobs, createMutex());
      const it = item({ id: "p1", title: "payload", body: "full" });
      await sync.apply({ op: "upsert-item", item: it });
      const walRow = db
        .prepare("SELECT payload_ref FROM zlcts_wal WHERE entity_id = 'p1'")
        .get() as { payload_ref: string };
      const bytes = blobs.get(walRow.payload_ref);
      expect(bytes).not.toBeNull();
      const parsed = JSON.parse(Buffer.from(bytes!).toString("utf8")) as { op: string };
      expect(parsed.op).toBe("upsert-item");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fold that throws does NOT leave an orphan: either both item+folded present or both absent", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "sync.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sync = createDeltaSyncBus(db, blobs, createMutex());
      // A deliberately bad item: empty kind is not a valid ItemKind but the
      // store.put does not validate kind. Instead, force a failure by making
      // store.put throw via a NOT NULL violation: null title. We build a
      // KnowledgeItem with title cast to "" then overwrite the row's title
      // column by hand is not possible through apply. Instead, use a supersede
      // on a non-existent id — fold calls store.supersede which is a no-op when
      // the row is missing, so it will NOT throw. To force a throw, put an item
      // whose id is so long it... no. Simplest reliable throw: feed a delta with
      // an op the fold handles, but make the DB reject the INSERT by disabling
      // the items table via a trigger that raises. We drop the table's columns
      // is not possible. Use a PRAGMA to make the db read-only is not supported
      // easily. Instead, simulate by pre-inserting a row with a conflicting
      // PRIMARY KEY and making the INSERT fail — but INSERT (not OR REPLACE) on
      // a conflicting PK throws. store.put checks getItem first; if it exists,
      // it UPDATEs. So to make it throw, we need UPDATE to fail. Set a CHECK
      // constraint is not possible post-hoc. The most reliable approach: add an
      // AFTER UPDATE trigger that raises on a sentinel id.
      db.exec(
        `CREATE TRIGGER zlcts_items_boom AFTER UPDATE ON zlcts_items
         WHEN new.id = 'boom' BEGIN
           SELECT RAISE(ABORT, 'deliberate boom');
         END`,
      );
      // First put the boom item via a direct INSERT (bypassing the store's UPDATE
      // path) so the trigger's UPDATE branch fires on apply.
      db.prepare(
        `INSERT INTO zlcts_items
           (id, kind, scope, title, body, why_gloss, rationale_json, fields_json,
            importance, confidence, staleness, status, revision, superseded_by,
            created_at, updated_at, last_verified_at, ttl_ms, tags, links_json,
            embedding_key, source_json, verification_json, embedding_vector)
         VALUES ('boom', 'decision', 'session', 't', 'b', NULL, NULL, NULL,
                 0.5, 0.5, 0, 'active', 1, NULL, 100, 100, 100, NULL, '[]', '[]',
                 'k', '{}', NULL, NULL)`,
      ).run();
      const it = item({ id: "boom", title: "updated", body: "b", revision: 2 });
      // apply should reject (fold throws) — the transaction must ROLLBACK, so
      // no WAL row is left behind and no partial update.
      await expect(sync.apply({ op: "upsert-item", item: it })).rejects.toThrow();
      // Invariant: no orphan. Either both the WAL row AND the folded update are
      // present, or both absent. Here the rollback means: no NEW WAL row for
      // this apply, and the item's title is unchanged (update was rolled back).
      const walForBoom = db
        .prepare("SELECT COUNT(*) AS n FROM zlcts_wal WHERE entity_id = 'boom'")
        .get() as { n: number };
      // The INSERT path on the very first apply would have created a row, but
      // we pre-inserted; this apply attempted UPDATE which threw + rolled back,
      // so no WAL row should have been committed for it.
      expect(walForBoom.n).toBe(0);
      const titleRow = db
        .prepare("SELECT title FROM zlcts_items WHERE id = 'boom'")
        .get() as { title: string };
      expect(titleRow.title).toBe("t"); // unchanged — update rolled back

      // Regression: the mutex tail must survive the rejected run and service a
      // subsequent apply. Drop the trigger so the next apply succeeds, then
      // prove the item materializes — the chain did not die with the throw.
      db.exec("DROP TRIGGER zlcts_items_boom");
      await sync.apply({ op: "upsert-item", item: item({ id: "after-throw" }) });
      const afterRow = db.prepare("SELECT id FROM zlcts_items WHERE id = 'after-throw'").get();
      expect(afterRow).toBeDefined();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});