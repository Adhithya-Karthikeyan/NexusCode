import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateMindDb } from "../src/migrate.js";
import { createBlobStore } from "../src/blobs.js";
import { createDeltaWAL, type WalEntry } from "../src/wal.js";

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
  return mkdtempSync(join(tmpdir(), "zlcts-wal-"));
}

function entry(lamport: number, payload: string): WalEntry {
  return {
    sessionId: "s1",
    lamportTs: lamport,
    actionId: `a${lamport}`,
    opType: "upsert-item",
    entityType: "item",
    entityId: `e${lamport}`,
    payload,
  };
}

describe("DeltaWAL", () => {
  it("append writes a row + blob", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "wal.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const wal = createDeltaWAL(db, blobs);
      const res = wal.append(entry(1, "payload-one"));
      expect(res.seq).toBe(1);
      expect(res.lamportTs).toBe(1);
      expect(res.payloadRef.startsWith("blob_")).toBe(true);
      expect(blobs.get(res.payloadRef)).not.toBeNull();
      const row = db.prepare("SELECT folded, durably_written FROM zlcts_wal WHERE seq = 1").get() as {
        folded: number;
        durably_written: number;
      };
      expect(row.folded).toBe(0);
      expect(row.durably_written).toBe(0);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flushSync sets durably_written", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "wal.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const wal = createDeltaWAL(db, blobs);
      wal.append(entry(1, "a"));
      wal.append(entry(2, "b"));
      wal.flushSync("s1", 2);
      const rows = db.prepare("SELECT seq, durably_written FROM zlcts_wal ORDER BY seq").all() as {
        seq: number;
        durably_written: number;
      }[];
      expect(rows.every((r) => r.durably_written === 1)).toBe(true);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unfolded returns pending (folded=0) entries", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "wal.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const wal = createDeltaWAL(db, blobs);
      wal.append(entry(1, "a"));
      wal.append(entry(2, "b"));
      const unfolded = wal.unfolded("s1");
      expect(unfolded.length).toBe(2);
      expect(unfolded[0]!.lamportTs).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("truncate removes entries with lamport > upToLamport", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "wal.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const wal = createDeltaWAL(db, blobs);
      wal.append(entry(1, "a"));
      wal.append(entry(2, "b"));
      wal.append(entry(3, "c"));
      wal.truncate("s1", 1);
      const rows = db.prepare("SELECT lamport_ts FROM zlcts_wal ORDER BY lamport_ts").all() as {
        lamport_ts: number;
      }[];
      expect(rows.map((r) => r.lamport_ts)).toEqual([1]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});