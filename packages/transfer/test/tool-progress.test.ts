import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateMindDb } from "../src/migrate.js";
import { createBlobStore } from "../src/blobs.js";
import { createToolProgress } from "../src/tool-progress.js";

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
  return mkdtempSync(join(tmpdir(), "zlcts-tp-"));
}

describe("ToolProgress", () => {
  it("append then readLatest returns latest stdout", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "tp.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const tp = createToolProgress(db, blobs);
      tp.append({ sessionId: "s1", turnId: "t1", tool: "bash", stdout: "line1\n" });
      tp.append({ sessionId: "s1", turnId: "t1", tool: "bash", stdout: "line1\nline2\n" });
      expect(tp.readLatest("s1", "t1", "bash")).toBe("line1\nline2\n");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("multiple appends keep one row per (session,turn,tool)", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "tp.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const tp = createToolProgress(db, blobs);
      for (let i = 0; i < 5; i++) {
        tp.append({ sessionId: "s1", turnId: "t1", tool: "bash", stdout: `out${i}` });
      }
      const rows = db
        .prepare("SELECT COUNT(*) AS n FROM zlcts_tool_progress WHERE session_id='s1' AND turn_id='t1' AND tool='bash'")
        .get() as { n: number };
      expect(rows.n).toBe(1);
      expect(tp.readLatest("s1", "t1", "bash")).toBe("out4");
      // distinct tools get distinct rows
      tp.append({ sessionId: "s1", turnId: "t1", tool: "grep", stdout: "g" });
      const rows2 = db
        .prepare("SELECT COUNT(*) AS n FROM zlcts_tool_progress WHERE session_id='s1' AND turn_id='t1'")
        .get() as { n: number };
      expect(rows2.n).toBe(2);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readLatest returns null for unknown", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "tp.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const tp = createToolProgress(db, blobs);
      expect(tp.readLatest("s1", "t1", "bash")).toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});