import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateMindDb } from "../src/migrate.js";
import { createBlobStore } from "../src/blobs.js";
import { createMutex } from "../src/mutex.js";
import { createDeltaSyncBus } from "../src/sync.js";
import { createItemStore } from "../src/store.js";
import { createPnkcSnapshotStore } from "../src/snapshot.js";
import { makeEmbeddingKey, ulid, type KnowledgeItem, type GraphNode } from "../src/items.js";
import { blobPath } from "../src/blobs.js";

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
  return mkdtempSync(join(tmpdir(), "zlcts-snap-"));
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

describe("PnkcSnapshotStore", () => {
  it("write snapshots items+nodes and latest/list/get return it", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "snap.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const store = createItemStore(db);
      store.put(item({ id: "i1", title: "one", body: "b1" }));
      store.put(item({ id: "i2", title: "two", body: "b2", status: "superseded" }));
      const node: GraphNode = { id: "N1", type: "module", label: "N1", attrs: {}, itemRefs: ["i1"], version: 1 };
      store.putNode(node);
      const snaps = createPnkcSnapshotStore(db, blobs);
      const ref = snaps.write("s1", 100);
      expect(ref.snapshotId.startsWith("snap_")).toBe(true);
      expect(ref.lamportTs).toBe(100);
      expect(ref.checksum.length).toBe(64);

      const latest = snaps.latest("s1");
      expect(latest).not.toBeNull();
      expect(latest!.snapshotId).toBe(ref.snapshotId);
      expect(latest!.lamportTs).toBe(100);

      const list = snaps.list("s1");
      expect(list.length).toBe(1);
      expect(list[0]!.snapshotId).toBe(ref.snapshotId);

      const got = snaps.get(ref.snapshotId);
      expect(got).not.toBeNull();
      expect(got!.blobRef).toBe(ref.blobRef);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list ordered by lamport DESC", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "snap.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const snaps = createPnkcSnapshotStore(db, blobs);
      snaps.write("s1", 10);
      snaps.write("s1", 30);
      snaps.write("s1", 20);
      const list = snaps.list("s1");
      expect(list.map((s) => s.lamportTs)).toEqual([30, 20, 10]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restore re-materializes items + nodes after DELETE-ing everything", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "snap.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const store = createItemStore(db);
      store.put(item({ id: "r1", title: "keep", body: "b" }));
      store.put(item({ id: "r2", title: "sup", body: "b2", status: "superseded" }));
      const node: GraphNode = { id: "RN", type: "module", label: "RN", attrs: {}, itemRefs: ["r1"], version: 1 };
      store.putNode(node);
      const snaps = createPnkcSnapshotStore(db, blobs);
      const ref = snaps.write("s1", 100);

      // Wipe everything
      db.exec("DELETE FROM zlcts_items");
      db.exec("DELETE FROM zlcts_graph_nodes");
      expect(store.get("r1")).toBeNull();
      expect(store.get("r2")).toBeNull();

      const res = snaps.restore(ref.snapshotId);
      expect(res.lamportTs).toBe(100);
      expect(res.sessionId).toBe("s1");
      // Items back (including superseded)
      expect(store.get("r1")).not.toBeNull();
      const r2 = store.get("r2");
      expect(r2).not.toBeNull();
      expect(r2!.status).toBe("superseded");
      // Node back
      const nRow = db.prepare("SELECT node_id FROM zlcts_graph_nodes WHERE node_id = 'RN'").get();
      expect(nRow).toBeDefined();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restore truncates WAL rows with lamport_ts > snapshot's", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "snap.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sync = createDeltaSyncBus(db, blobs, createMutex());
      const snaps = createPnkcSnapshotStore(db, blobs);

      // Apply deltas at lamport 1..3 (items updatedAt = lamport for upsert-item
      // via item.updatedAt; use explicit execution-event deltas for control).
      await sync.apply({
        op: "execution-event",
        sessionId: "s1",
        lamportTs: 1,
        actionId: "a1",
        entityId: "e1",
        title: "t1",
        body: "b1",
        fields: {
          runId: "r",
          turnId: "t",
          action: "bash",
          result: "success",
          projectorVersion: 1,
          deltaKids: { added: [], updated: [], invalidated: [] },
          deltaFiles: [],
          tokensIn: 1,
          tokensOut: 1,
        },
      });
      await sync.apply({
        op: "execution-event",
        sessionId: "s1",
        lamportTs: 2,
        actionId: "a2",
        entityId: "e2",
        title: "t2",
        body: "b2",
        fields: {
          runId: "r",
          turnId: "t",
          action: "bash",
          result: "success",
          projectorVersion: 1,
          deltaKids: { added: [], updated: [], invalidated: [] },
          deltaFiles: [],
          tokensIn: 1,
          tokensOut: 1,
        },
      });
      // Snapshot at lamport 2
      const ref = snaps.write("s1", 2);
      // Apply more at lamport 3, 4
      await sync.apply({
        op: "execution-event",
        sessionId: "s1",
        lamportTs: 3,
        actionId: "a3",
        entityId: "e3",
        title: "t3",
        body: "b3",
        fields: {
          runId: "r",
          turnId: "t",
          action: "bash",
          result: "success",
          projectorVersion: 1,
          deltaKids: { added: [], updated: [], invalidated: [] },
          deltaFiles: [],
          tokensIn: 1,
          tokensOut: 1,
        },
      });
      await sync.apply({
        op: "execution-event",
        sessionId: "s1",
        lamportTs: 4,
        actionId: "a4",
        entityId: "e4",
        title: "t4",
        body: "b4",
        fields: {
          runId: "r",
          turnId: "t",
          action: "bash",
          result: "success",
          projectorVersion: 1,
          deltaKids: { added: [], updated: [], invalidated: [] },
          deltaFiles: [],
          tokensIn: 1,
          tokensOut: 1,
        },
      });
      const beforeRows = db
        .prepare("SELECT lamport_ts FROM zlcts_wal WHERE session_id = 's1' ORDER BY lamport_ts")
        .all() as { lamport_ts: number }[];
      expect(beforeRows.map((r) => r.lamport_ts)).toEqual([1, 2, 3, 4]);

      snaps.restore(ref.snapshotId);
      const afterRows = db
        .prepare("SELECT lamport_ts FROM zlcts_wal WHERE session_id = 's1' ORDER BY lamport_ts")
        .all() as { lamport_ts: number }[];
      // rows > 2 (snapshot lamport) are gone; rows <= 2 kept
      expect(afterRows.map((r) => r.lamport_ts)).toEqual([1, 2]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restore rejects a snapshot whose blob was corrupted (checksum mismatch) and does NOT mutate the PNKC", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "snap.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const store = createItemStore(db);
      store.put(item({ id: "c1", title: "one", body: "b1" }));
      const snaps = createPnkcSnapshotStore(db, blobs);
      const ref = snaps.write("s1", 100);

      // Bit-rot the snapshot blob on disk.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(blobPath(dir, ref.blobRef), Buffer.from("BIT-ROTTED-SNAPSHOT"));

      // restore must throw — never silently materialize corrupt state.
      expect(() => snaps.restore(ref.snapshotId)).toThrow(/snapshot corrupted/);
      // The checksum check runs BEFORE the DELETE/INSERT, so the live PNKC is
      // untouched by the failed restore.
      expect(store.get("c1")).not.toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("restore rejects a snapshot whose blob was replaced with valid-but-wrong JSON (checksum catches it before materialization)", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "snap.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const store = createItemStore(db);
      store.put(item({ id: "c2", title: "real", body: "b" }));
      const snaps = createPnkcSnapshotStore(db, blobs);
      const ref = snaps.write("s1", 100);

      // Replace the blob with VALID JSON describing a different (empty) PNKC.
      // JSON.parse would succeed, so without the checksum guard restore would
      // silently wipe the live PNKC to the empty state.
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        blobPath(dir, ref.blobRef),
        Buffer.from(
          JSON.stringify({ items: [], graphNodes: [], graphEdges: [], summaries: [] }),
        ),
      );

      expect(() => snaps.restore(ref.snapshotId)).toThrow(/snapshot corrupted/);
      expect(store.get("c2")).not.toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});