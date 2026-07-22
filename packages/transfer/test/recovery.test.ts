import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateMindDb } from "../src/migrate.js";
import { createBlobStore } from "../src/blobs.js";
import { createMutex } from "../src/mutex.js";
import { createDeltaSyncBus, recoverUnfolded } from "../src/sync.js";
import {
  makeEmbeddingKey,
  ulid,
  type Delta,
  type EpisodicFields,
  type GraphEdge,
  type GraphNode,
  type KnowledgeItem,
} from "../src/items.js";

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
  return mkdtempSync(join(tmpdir(), "zlcts-rec-"));
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

describe("WAL recovery (refold + recoverUnfolded)", () => {
  it("full-delta payload round-trips: parse a WAL row's payload blob → equals the original delta", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "rec.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sync = createDeltaSyncBus(db, blobs, createMutex());

      const it = item({ id: "rt1", title: "roundtrip", body: "body" });
      const delta: Delta = { op: "upsert-item", item: it };
      await sync.apply(delta);

      const walRow = db
        .prepare("SELECT payload_ref FROM zlcts_wal WHERE entity_id = 'rt1'")
        .get() as { payload_ref: string };
      const bytes = blobs.get(walRow.payload_ref);
      expect(bytes).not.toBeNull();
      const parsed = JSON.parse(Buffer.from(bytes!).toString("utf8")) as Delta;
      expect(parsed).toEqual(delta);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recoverUnfolded re-folds upsert-item + execution-event deltas; both items present, both folded=1", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "rec.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sync = createDeltaSyncBus(db, blobs, createMutex());

      const upsertDelta: Delta = { op: "upsert-item", item: item({ id: "r-up", title: "up", body: "b" }) };
      const execDelta: Delta = {
        op: "execution-event",
        sessionId: "s1",
        lamportTs: 7,
        actionId: "bash-7",
        entityId: "r-ee",
        title: "Ran bash",
        body: "ok",
        fields,
      };
      await sync.apply(upsertDelta);
      await sync.apply(execDelta);

      // Simulate a crash: wipe materialized items, reset folded=0 for both rows.
      db.exec("DELETE FROM zlcts_items");
      db.exec("UPDATE zlcts_wal SET folded = 0");

      const res = recoverUnfolded(db, blobs, createMutex());
      expect(res.recovered).toBe(2);
      // upsert-item derives sessionId from item.source.ref ("s1");
      // execution-event carries sessionId "s1".
      expect(res.sessions).toEqual(["s1"]);

      const upRow = db.prepare("SELECT id FROM zlcts_items WHERE id = 'r-up'").get();
      expect(upRow).toBeDefined();
      const eeRow = db.prepare("SELECT id, kind FROM zlcts_items WHERE id = 'r-ee'").get() as {
        kind: string;
      } | undefined;
      expect(eeRow).toBeDefined();
      expect(eeRow!.kind).toBe("execution-event");

      const foldedRows = db
        .prepare("SELECT folded FROM zlcts_wal ORDER BY seq")
        .all() as { folded: number }[];
      expect(foldedRows.every((r) => r.folded === 1)).toBe(true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recoverUnfolded is idempotent: a second call recovers 0", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "rec.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sync = createDeltaSyncBus(db, blobs, createMutex());
      await sync.apply({ op: "upsert-item", item: item({ id: "idem1", title: "i", body: "b" }) });
      db.exec("DELETE FROM zlcts_items");
      db.exec("UPDATE zlcts_wal SET folded = 0");
      const first = recoverUnfolded(db, blobs, createMutex());
      expect(first.recovered).toBe(1);
      const second = recoverUnfolded(db, blobs, createMutex());
      expect(second.recovered).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recoverUnfolded re-folds all 7 op types: items/nodes/edges re-materialize, capture/handoff fold to no-op", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "rec.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sync = createDeltaSyncBus(db, blobs, createMutex());

      // 1. upsert-item (low lamport so it refolds before the supersede).
      await sync.apply({ op: "upsert-item", item: item({ id: "sup-target", title: "t", body: "b" }) });
      // 2. supersede-item referencing the prior item.
      await sync.apply({ op: "supersede-item", id: "sup-target", byId: "sup-replacement", sessionId: "s1" });
      // 3. put-node.
      const node: GraphNode = {
        id: "n1",
        type: "module",
        label: "mod",
        attrs: {},
        itemRefs: [],
        version: 1,
      };
      await sync.apply({ op: "put-node", node, sessionId: "s1" });
      // 4. put-edge (references the node; putEdge does not validate existence).
      const edge: GraphEdge = {
        edgeId: "e1",
        from: "n1",
        to: "n1",
        kind: "calls",
        version: 1,
        confidence: 0.9,
        verified: true,
      };
      await sync.apply({ op: "put-edge", edge, sessionId: "s1" });
      // 5. execution-event.
      await sync.apply({
        op: "execution-event",
        sessionId: "s1",
        lamportTs: 500,
        actionId: "bash-500",
        entityId: "ee7",
        title: "Ran bash",
        body: "ok",
        fields,
      });
      // 6. capture (WAL-only, no materialized item).
      await sync.apply({ op: "capture", sessionId: "s1", lamportTs: 600, payload: "raw-capture" });
      // 7. handoff (WAL-only, no materialized item).
      await sync.apply({
        op: "handoff",
        sessionId: "s1",
        lamportTs: 700,
        fromProvider: "p1",
        toProvider: "p2",
        reason: "failover",
      });

      // Simulate a crash: wipe materialized tables, reset all WAL rows folded=0.
      db.exec("DELETE FROM zlcts_items");
      db.exec("DELETE FROM zlcts_graph_nodes");
      db.exec("DELETE FROM zlcts_graph_edges");
      db.exec("UPDATE zlcts_wal SET folded = 0");

      const res = recoverUnfolded(db, blobs, createMutex());
      // All 7 refolds succeed (capture/handoff fold to a no-op but still count
      // as recovered since refold runs without throwing).
      expect(res.recovered).toBe(7);
      expect(res.failed).toBe(0);

      // upsert-item re-appears AND the supersede set superseded_by on it.
      const upRow = db
        .prepare("SELECT id, superseded_by FROM zlcts_items WHERE id = 'sup-target'")
        .get() as { id: string; superseded_by: string | null } | undefined;
      expect(upRow).toBeDefined();
      expect(upRow!.superseded_by).toBe("sup-replacement");

      // put-node re-appears.
      const nodeRow = db.prepare("SELECT node_id FROM zlcts_graph_nodes WHERE node_id = 'n1'").get();
      expect(nodeRow).toBeDefined();

      // put-edge re-appears.
      const edgeRow = db.prepare("SELECT edge_id FROM zlcts_graph_edges WHERE edge_id = 'e1'").get();
      expect(edgeRow).toBeDefined();

      // execution-event re-appears with kind='execution-event'.
      const eeRow = db.prepare("SELECT id, kind FROM zlcts_items WHERE id = 'ee7'").get() as
        | { id: string; kind: string }
        | undefined;
      expect(eeRow).toBeDefined();
      expect(eeRow!.kind).toBe("execution-event");

      // capture/handoff are WAL-only: no item row, but their WAL rows folded=1.
      const captureItem = db.prepare("SELECT id FROM zlcts_items WHERE id = 's1-600'").get();
      expect(captureItem).toBeUndefined();
      const handoffItem = db.prepare("SELECT id FROM zlcts_items WHERE id = 's1-700'").get();
      expect(handoffItem).toBeUndefined();
      const foldedRows = db
        .prepare("SELECT folded FROM zlcts_wal ORDER BY seq")
        .all() as { folded: number }[];
      expect(foldedRows.length).toBe(7);
      expect(foldedRows.every((r) => r.folded === 1)).toBe(true);

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recoverUnfolded: one missing payload blob does NOT abort recovery — recovered + failed counted, no throw", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "rec.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sync = createDeltaSyncBus(db, blobs, createMutex());

      // Row A: a real upsert (valid blob), lamport = item.updatedAt = 100.
      await sync.apply({ op: "upsert-item", item: item({ id: "good1", title: "g", body: "b" }) });
      // Row B: an unfolded WAL row whose payload blob does NOT exist.
      db.prepare(
        `INSERT INTO zlcts_wal (session_id, sub_id, lamport_ts, action_id, op_type, entity_type, entity_id, payload_ref, checksum, written_at, durably_written, folded)
         VALUES (?, NULL, ?, ?, 'execution-event', 'item', ?, 'blob_missing_ref', 'x', ?, 1, 0)`,
      ).run("s1", 999, "a-missing", "missing1", Date.now());

      // Simulate a crash: wipe materialized items + reset every row folded=0.
      db.exec("DELETE FROM zlcts_items");
      db.exec("UPDATE zlcts_wal SET folded = 0");

      // Must not throw despite the missing blob.
      const res = recoverUnfolded(db, blobs, createMutex());
      expect(res.recovered).toBe(1);
      expect(res.failed).toBe(1);

      // The good row re-materialized and is folded; the missing-blob row stays
      // unfolded (left for a later integrity pass / snapshot restore).
      expect(db.prepare("SELECT id FROM zlcts_items WHERE id = 'good1'").get()).toBeDefined();
      const goodFolded = db
        .prepare("SELECT folded FROM zlcts_wal WHERE entity_id = 'good1'")
        .get() as { folded: number };
      expect(goodFolded.folded).toBe(1);
      const missingFolded = db
        .prepare("SELECT folded FROM zlcts_wal WHERE entity_id = 'missing1'")
        .get() as { folded: number };
      expect(missingFolded.folded).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});