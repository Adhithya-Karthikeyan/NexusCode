import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateMindDb } from "../src/migrate.js";
import { createBlobStore } from "../src/blobs.js";
import { createVerbatimSink } from "../src/verbatim.js";
import type { StreamChunk } from "@nexuscode/shared";

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
  return mkdtempSync(join(tmpdir(), "zlcts-verbatim-"));
}

describe("VerbatimSink", () => {
  it("write then read returns the raw unredacted payload; row in zlcts_verbatim", async () => {
    const dir = tmp();
    try {
      const db = await openDb(join(dir, "verb.db"));
      migrateMindDb(db);
      const blobs = createBlobStore(dir);
      const sink = createVerbatimSink(db, blobs);
      const chunk: StreamChunk = {
        type: "text-delta",
        runId: "r1",
        text: "secret-token-xyz and normal text",
      };
      sink.write(chunk, { sessionId: "s1", lamportTs: 1 });
      const row = db.prepare("SELECT seq, chunk_type, payload_ref, encrypted FROM zlcts_verbatim WHERE seq = 1").get() as {
        seq: number;
        chunk_type: string;
        payload_ref: string;
        encrypted: number;
      };
      expect(row.chunk_type).toBe("text-delta");
      expect(row.encrypted).toBe(0);
      const read = sink.read(1);
      expect(read).not.toBeNull();
      expect(read!.chunkType).toBe("text-delta");
      const text = Buffer.from(read!.payload!).toString("utf8");
      expect(text).toContain("secret-token-xyz");
      // raw unredacted payload survives verbatim
      const parsed = JSON.parse(text) as StreamChunk;
      expect(parsed.type).toBe("text-delta");
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});