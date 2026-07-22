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
import { createIntegrityRepair } from "../src/integrity.js";
import { makeEmbeddingKey, ulid, type KnowledgeItem, type GraphEdge } from "../src/items.js";
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
  return mkdtempSync(join(tmpdir(), "zlcts-int-"));
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

describe("IntegrityRepair", () => {
  it("clean db: no orphans, unfoldedWal=0, hashChanged=false", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "int.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const snaps = createPnkcSnapshotStore(db, blobs);
      const repair = createIntegrityRepair(db, blobs, snaps);
      const report = repair.check();
      expect(report.orphanEdges).toEqual([]);
      expect(report.orphanAssumptions).toEqual([]);
      expect(report.unfoldedWal).toBe(0);
      expect(report.walChecksumMismatches).toEqual([]);
      expect(report.hashChanged).toBe(false);
      expect(report.lossEvents).toEqual([]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("orphan edge detected and repair deletes it", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "int.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const store = createItemStore(db);
      // Only one node; edge points to a missing node "GHOST"
      store.putNode({ id: "REAL", type: "module", label: "R", attrs: {}, itemRefs: [], version: 1 });
      const edge: GraphEdge = {
        edgeId: "E1",
        from: "REAL",
        to: "GHOST",
        kind: "calls",
        version: 1,
        confidence: 0.9,
        verified: true,
      };
      store.putEdge(edge);
      const snaps = createPnkcSnapshotStore(db, blobs);
      const repair = createIntegrityRepair(db, blobs, snaps);
      const report = repair.check();
      expect(report.orphanEdges.length).toBe(1);
      expect(report.orphanEdges[0]!.edgeId).toBe("E1");

      const actions = repair.repair(report);
      const deleted = actions.find((a) => a.kind === "deleted-orphan-edge");
      expect(deleted).toBeDefined();
      const row = db.prepare("SELECT edge_id FROM zlcts_graph_edges WHERE edge_id = 'E1'").get();
      expect(row).toBeUndefined();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("corrupt WAL blob → checksum mismatch → repair restores snapshot + records loss", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "int.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const store = createItemStore(db);
      const sync = createDeltaSyncBus(db, blobs, createMutex());
      const snaps = createPnkcSnapshotStore(db, blobs);
      const repair = createIntegrityRepair(db, blobs, snaps);

      // Put an item + snapshot a stable state.
      store.put(item({ id: "keep1", title: "keep", body: "k" }));
      const snapRef = snaps.write("s1", 50);

      // Append a WAL row whose blob we then corrupt.
      await sync.apply({ op: "upsert-item", item: item({ id: "post1", title: "post", body: "p" }) });
      // Corrupt the blob for the last WAL row.
      const walRow = db
        .prepare("SELECT payload_ref FROM zlcts_wal ORDER BY seq DESC LIMIT 1")
        .get() as { payload_ref: string };
      const path = blobPath(dir, walRow.payload_ref);
      // Overwrite with different bytes (append garbage).
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, Buffer.from("CORRUPTED-CONTENT"));

      const report = repair.check();
      expect(report.walChecksumMismatches.length).toBe(1);

      const actions = repair.repair(report);
      expect(actions.some((a) => a.kind === "restored-snapshot")).toBe(true);
      expect(actions.some((a) => a.kind === "recorded-loss")).toBe(true);

      // Loss event recorded in integrity table.
      const lossRow = db.prepare("SELECT v FROM zlcts_integrity WHERE k = 'loss'").get() as {
        v: string;
      };
      const lossArr = JSON.parse(lossRow.v) as { reason: string }[];
      expect(lossArr.length).toBeGreaterThanOrEqual(1);
      // snapRef used implicitly via restore; reference to keep linter happy.
      expect(snapRef.snapshotId.startsWith("snap_")).toBe(true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unfolded WAL → recoverUnfolded re-folds it and item appears", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "int.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const store = createItemStore(db);
      const sync = createDeltaSyncBus(db, blobs, createMutex());
      const snaps = createPnkcSnapshotStore(db, blobs);
      const repair = createIntegrityRepair(db, blobs, snaps);

      // Apply an upsert-item delta, then mark its WAL row unfolded (simulate a
      // crash after append but before markFolded — but fold already happened
      // here; to simulate the real crash, delete the item too).
      await sync.apply({ op: "upsert-item", item: item({ id: "u1", title: "u1", body: "b" }) });
      // Simulate crash: delete the materialized item + reset folded=0.
      db.exec("DELETE FROM zlcts_items WHERE id = 'u1'");
      db.exec("UPDATE zlcts_wal SET folded = 0 WHERE entity_id = 'u1'");
      expect(store.get("u1")).toBeNull();

      const report = repair.check();
      expect(report.unfoldedWal).toBeGreaterThanOrEqual(1);
      const actions = repair.repair(report);
      expect(actions.some((a) => a.kind === "replayed-wal")).toBe(true);
      expect(store.get("u1")).not.toBeNull();
      const foldedRow = db
        .prepare("SELECT folded FROM zlcts_wal WHERE entity_id = 'u1'")
        .get() as { folded: number };
      expect(foldedRow.folded).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("repair resets the stableHash baseline to the POST-repair state — a second check does not re-fire (no cascading false DataLoss)", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "int.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const store = createItemStore(db);
      const sync = createDeltaSyncBus(db, blobs, createMutex());
      const snaps = createPnkcSnapshotStore(db, blobs);
      const repair = createIntegrityRepair(db, blobs, snaps);

      // Stable state + snapshot at lamport 50, then a post-snapshot upsert.
      store.put(item({ id: "keep1", title: "keep", body: "k" }));
      snaps.write("s1", 50);
      await sync.apply({ op: "upsert-item", item: item({ id: "post1", title: "post", body: "p" }) });
      // Corrupt the post-snapshot WAL blob.
      const walRow = db
        .prepare("SELECT payload_ref FROM zlcts_wal ORDER BY seq DESC LIMIT 1")
        .get() as { payload_ref: string };
      const path = blobPath(dir, walRow.payload_ref);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(path, Buffer.from("CORRUPTED-CONTENT"));

      const report1 = repair.check();
      expect(report1.walChecksumMismatches.length).toBe(1);
      repair.repair(report1);
      const lossRow1 = db.prepare("SELECT v FROM zlcts_integrity WHERE k = 'loss'").get() as {
        v: string;
      };
      const lossCount1 = (JSON.parse(lossRow1.v) as unknown[]).length;

      // Second check on the now-repaired db: the baseline must have been reset
      // to the POST-repair hash, so hashChanged is false and repair is a no-op
      // — no second snapshot restore, no new loss event (no cascade).
      const report2 = repair.check();
      expect(report2.hashChanged).toBe(false);
      expect(report2.walChecksumMismatches.length).toBe(0); // corrupt row truncated by the first restore
      const actions2 = repair.repair(report2);
      expect(actions2.some((a) => a.kind === "restored-snapshot")).toBe(false);
      expect(actions2.some((a) => a.kind === "recorded-loss")).toBe(false);
      const lossRow2 = db.prepare("SELECT v FROM zlcts_integrity WHERE k = 'loss'").get() as {
        v: string;
      };
      const lossCount2 = (JSON.parse(lossRow2.v) as unknown[]).length;
      expect(lossCount2).toBe(lossCount1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});