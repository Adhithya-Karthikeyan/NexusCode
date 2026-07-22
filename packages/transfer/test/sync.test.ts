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
});