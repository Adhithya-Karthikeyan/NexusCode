import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateMindDb } from "../src/migrate.js";
import { createItemStore } from "../src/store.js";
import { makeEmbeddingKey, ulid, type KnowledgeItem, type GraphNode, type GraphEdge } from "../src/items.js";

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
  return mkdtempSync(join(tmpdir(), "zlcts-store-"));
}

function item(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  const id = overrides.id ?? ulid();
  const title = overrides.title ?? "Decision title";
  const body = overrides.body ?? "Decision body";
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
    tags: ["db"],
    embeddingKey: makeEmbeddingKey({ title, body, tags: ["db"] }),
    source: { origin: "user", ref: "s1" },
    ...overrides,
  };
}

describe("ItemStore", () => {
  it("put/get round-trips an item", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "store.db"));
      migrateMindDb(db);
      const store = createItemStore(db);
      const it = item({ title: "Use sqlite", body: "because durability" });
      store.put(it);
      const got = store.get(it.id);
      expect(got).not.toBeNull();
      expect(got!.title).toBe("Use sqlite");
      expect(got!.body).toBe("because durability");
      expect(got!.tags).toEqual(["db"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("list filters by kind/scope/status", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "store.db"));
      migrateMindDb(db);
      const store = createItemStore(db);
      store.put(item({ id: "a", kind: "decision", scope: "session", status: "active" }));
      store.put(item({ id: "b", kind: "failure", scope: "project", status: "active" }));
      store.put(item({ id: "c", kind: "decision", scope: "session", status: "superseded" }));
      expect(store.list({ kind: "decision" }).length).toBe(2);
      expect(store.list({ scope: "project" }).length).toBe(1);
      expect(store.list({ status: "active" }).length).toBe(2);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supersede flips status and bumps revision", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "store.db"));
      migrateMindDb(db);
      const store = createItemStore(db);
      store.put(item({ id: "x" }));
      store.supersede("x", "y");
      const got = store.get("x");
      expect(got!.status).toBe("superseded");
      expect(got!.supersededBy).toBe("y");
      expect(got!.revision).toBe(2);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FTS search finds by keyword and excludes superseded", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "store.db"));
      migrateMindDb(db);
      const store = createItemStore(db);
      store.put(item({ id: "k1", title: "Use sqlite for store", body: "because durability" }));
      store.put(item({ id: "k2", title: "Other decision", body: "unrelated content" }));
      const hits = store.searchFTS("sqlite", 10);
      expect(hits.length).toBe(1);
      expect(hits[0]!.id).toBe("k1");
      // supersede k1 → search should exclude it
      store.supersede("k1", "k2");
      const hits2 = store.searchFTS("sqlite", 10);
      expect(hits2.length).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FTS search degrades to [] on a malformed FTS5 query (no crash)", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "store.db"));
      migrateMindDb(db);
      const store = createItemStore(db);
      store.put(item({ id: "k1", title: "Use sqlite for store", body: "because durability" }));
      // Unbalanced quote / bare operator triggers an FTS5 syntax exception;
      // the guard must swallow it and return [] rather than throwing.
      expect(store.searchFTS('"unbalanced', 10)).toEqual([]);
      expect(store.searchFTS("*", 10)).toEqual([]);
      // A well-formed query still works after the bad ones.
      expect(store.searchFTS("sqlite", 10).length).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-overwrite: older revision ignored", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "store.db"));
      migrateMindDb(db);
      const store = createItemStore(db);
      store.put(item({ id: "n1", revision: 2, body: "newer" }));
      store.put(item({ id: "n1", revision: 1, body: "older" }));
      expect(store.get("n1")!.body).toBe("newer");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-overwrite: newer revision wins", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "store.db"));
      migrateMindDb(db);
      const store = createItemStore(db);
      store.put(item({ id: "n2", revision: 1, body: "old" }));
      store.put(item({ id: "n2", revision: 2, body: "new" }));
      expect(store.get("n2")!.body).toBe("new");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-overwrite: equal rev, higher confidence wins", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "store.db"));
      migrateMindDb(db);
      const store = createItemStore(db);
      store.put(item({ id: "n3", revision: 1, confidence: 0.5, body: "low-conf" }));
      store.put(item({ id: "n3", revision: 1, confidence: 0.9, body: "high-conf" }));
      expect(store.get("n3")!.body).toBe("high-conf");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-overwrite: equal rev + equal conf → existing kept", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "store.db"));
      migrateMindDb(db);
      const store = createItemStore(db);
      store.put(item({ id: "n4", revision: 1, confidence: 0.5, body: "first" }));
      store.put(item({ id: "n4", revision: 1, confidence: 0.5, body: "second" }));
      expect(store.get("n4")!.body).toBe("first");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("KG neighbors BFS excludes tentative edges + cycle guard", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "store.db"));
      migrateMindDb(db);
      const store = createItemStore(db);
      const nA: GraphNode = { id: "A", type: "module", label: "A", attrs: {}, itemRefs: [], version: 1 };
      const nB: GraphNode = { id: "B", type: "module", label: "B", attrs: {}, itemRefs: [], version: 1 };
      const nC: GraphNode = { id: "C", type: "module", label: "C", attrs: {}, itemRefs: [], version: 1 };
      store.putNode(nA);
      store.putNode(nB);
      store.putNode(nC);
      // A -> B verified high-conf (included)
      const eAB: GraphEdge = {
        edgeId: "AB",
        from: "A",
        to: "B",
        kind: "calls",
        version: 1,
        confidence: 0.95,
        verified: true,
      };
      // A -> C tentative (unverified, low conf) — excluded
      const eAC: GraphEdge = {
        edgeId: "AC",
        from: "A",
        to: "C",
        kind: "calls",
        version: 1,
        confidence: 0.3,
        verified: false,
      };
      // B -> A cycle (verified) — cycle guard should prevent re-visit
      const eBA: GraphEdge = {
        edgeId: "BA",
        from: "B",
        to: "A",
        kind: "calls",
        version: 1,
        confidence: 0.95,
        verified: true,
      };
      store.putEdge(eAB);
      store.putEdge(eAC);
      store.putEdge(eBA);
      const res = store.neighbors("A", 3);
      // Nodes: A, B (C excluded because tentative edge). Cycle guard prevents infinite.
      const ids = res.nodes.map((n) => n.id).sort();
      expect(ids).toEqual(["A", "B"]);
      // Edges: AB and BA (AC excluded as tentative)
      const edgeIds = res.edges.map((e) => e.edgeId).sort();
      expect(edgeIds).toEqual(["AB", "BA"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("KG neighbors includes tentative edges when tentativeOk=true", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "store.db"));
      migrateMindDb(db);
      const store = createItemStore(db);
      store.putNode({ id: "X", type: "module", label: "X", attrs: {}, itemRefs: [], version: 1 });
      store.putNode({ id: "Y", type: "module", label: "Y", attrs: {}, itemRefs: [], version: 1 });
      store.putEdge({
        edgeId: "XY",
        from: "X",
        to: "Y",
        kind: "calls",
        version: 1,
        confidence: 0.3,
        verified: false,
      });
      const res = store.neighbors("X", 2, { tentativeOk: true });
      expect(res.nodes.map((n) => n.id).sort()).toEqual(["X", "Y"]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});