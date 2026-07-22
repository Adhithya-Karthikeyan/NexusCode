import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  migrateMindDb,
  createBlobStore,
  createMutex,
  createTransferHandle,
  type DbLike,
} from "@nexuscode/transfer";
import type { StreamChunk } from "@nexuscode/shared";

const RUN = "run_test";

/** Build a minimal StreamChunk of the given type (test-only; fields cast). */
const mkChunk = (p: object): StreamChunk => ({ runId: RUN, ...p } as unknown as StreamChunk);

async function setup() {
  const { default: Database } = (await import("better-sqlite3")) as unknown as {
    default: new (p: string) => DbLike;
  };
  const db = new Database(":memory:");
  migrateMindDb(db);
  const dir = mkdtempSync(join(tmpdir(), "zlcts-handle-"));
  const blobs = createBlobStore(dir);
  const mutex = createMutex();
  const handle = createTransferHandle({
    db,
    blobs,
    mutex,
    sessionId: "s1",
    runId: RUN,
    turnId: "t1",
  });
  return { db, blobs, handle, dir };
}

const count = (db: DbLike, sql: string, ...params: unknown[]): number =>
  (db.prepare(sql).get(...params) as { c: number }).c;

describe("TransferHandle — end-to-end capture", () => {
  it("captures every chunk verbatim + projects execution-events into the PNKC", async () => {
    const { db, handle, dir } = await setup();
    try {
      const chunks: StreamChunk[] = [
        mkChunk({ type: "run-start" }),
        mkChunk({ type: "tool-call-start", id: "tc1", name: "echo" }),
        mkChunk({ type: "tool-call-end", id: "tc1", input: { text: "hi" } }),
        mkChunk({
          type: "tool-result",
          toolCallId: "tc1",
          content: [{ type: "text", text: "echoed: hi" }],
          isError: false,
        }),
        mkChunk({ type: "run-end", finishReason: "stop", message: { role: "assistant", content: [] } }),
      ];
      await handle.turnBoundary("start", 0);
      for (const c of chunks) {
        handle.captureVerbatim(c);
        await handle.project(c);
      }
      handle.recordToolOutput("echo", "echoed: hi");
      await handle.turnBoundary("end", 0);

      // Every chunk was written verbatim (unredacted) — 5 chunks.
      expect(count(db, "SELECT COUNT(*) c FROM zlcts_verbatim WHERE session_id=?", "s1")).toBe(5);

      // Execution-events folded into items: tool-call-start, tool-call-end,
      // tool-result, run-end = 4, plus 2 turn-boundary events = 6.
      expect(count(db, "SELECT COUNT(*) c FROM zlcts_items WHERE kind='execution-event'")).toBe(6);

      // Every folded delta has a folded=1 WAL row: 4 chunk deltas + 2 turn
      // boundaries = 6 (run-start is a projector noop → no WAL row).
      expect(count(db, "SELECT COUNT(*) c FROM zlcts_wal WHERE session_id=? AND folded=1", "s1")).toBe(6);

      // Tool output captured for mid-call-termination resume.
      expect(count(db, "SELECT COUNT(*) c FROM zlcts_tool_progress WHERE tool='echo'")).toBe(1);

      // The tool name was recovered on tool-call-end / tool-result (not
      // anonymous "tool-call-end"): the items carry the name as a tag.
      const named = db
        .prepare("SELECT COUNT(*) c FROM zlcts_items WHERE tags LIKE '%action:echo%'")
        .get() as { c: number };
      expect(named.c).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("flush marks the WAL durably written up to the high-water lamport", async () => {
    const { db, handle, dir } = await setup();
    try {
      await handle.turnBoundary("start", 0);
      handle.captureVerbatim(mkChunk({ type: "run-start" }));
      handle.flush();
      expect(
        count(db, "SELECT COUNT(*) c FROM zlcts_wal WHERE session_id=? AND durably_written=1", "s1"),
      ).toBeGreaterThanOrEqual(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never throws into the runner when the db is fine (isolation contract holds)", async () => {
    const { handle, dir } = await setup();
    try {
      await handle.turnBoundary("start", 0);
      await handle.project(mkChunk({ type: "tool-call-start", id: "x", name: "echo" }));
      handle.recordToolOutput("echo", "ok");
      // No throw is the contract.
      expect(true).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});