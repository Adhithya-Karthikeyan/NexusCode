/**
 * The durable transcript table — the only place in the history db that holds the
 * user's own words. Two properties matter more than round-tripping: it is written
 * only when enabled, is redacted first, and is encrypted at rest by default.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@nexuscode/shared";
import { latestStoredSession, openHistory } from "../src/history.js";

function tmpDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "nx-transcript-")), "history.db");
}

function user(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistant(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

describe("history — durable transcript (storePrompts)", () => {
  it("round-trips a conversation in order when storePrompts is on", async () => {
    const dbPath = tmpDbPath();
    const store = await openHistory({ enabled: true, dbPath, storePrompts: true });
    try {
      store.appendTranscript!({ sessionId: "s1", turnId: "t1", seq: 0, messages: [user("one")] });
      store.appendTranscript!({ sessionId: "s1", turnId: "t1", seq: 1, messages: [assistant("first")] });
      store.appendTranscript!({ sessionId: "s1", turnId: "t2", seq: 2, messages: [user("two")] });

      const loaded = await store.loadTranscript!("s1");
      expect(loaded.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      expect(loaded.map((m) => (m.content[0] as { text: string }).text)).toEqual([
        "one",
        "first",
        "two",
      ]);
    } finally {
      store.close();
    }
  });

  it("round-trips a tool-role message's toolCallId and name (needed to resume tool pairing)", async () => {
    const dbPath = tmpDbPath();
    const store = await openHistory({ enabled: true, dbPath, storePrompts: true });
    try {
      const toolCall: Message = {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "echo", input: { text: "hi" } }],
      };
      const toolResult: Message = {
        role: "tool",
        toolCallId: "call_1",
        name: "echo",
        content: [{ type: "text", text: "echoed: hi" }],
      };
      store.appendTranscript!({
        sessionId: "s1",
        turnId: "t1",
        seq: 0,
        messages: [user("hi"), toolCall, toolResult, assistant("done")],
      });

      const loaded = await store.loadTranscript!("s1");
      expect(loaded.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
      const restoredResult = loaded[2]!;
      expect(restoredResult.toolCallId).toBe("call_1");
      expect(restoredResult.name).toBe("echo");
    } finally {
      store.close();
    }
  });

  it("still decodes a pre-existing bare ContentBlock[] row (written before toolCallId was persisted)", async () => {
    // Simulate a row written by the OLD encoding — JSON.stringify(content)
    // directly, with no {content, toolCallId, name} envelope — by inserting it
    // straight through the raw db handle, unencrypted; decodeTranscript treats
    // any value not prefixed "enc:v1:" as plaintext, so this is realistic for
    // a pre-encryption-default row too.
    const dbPath = tmpDbPath();
    // Create the schema first (openHistory runs `CREATE TABLE IF NOT EXISTS`
    // on open) — a bare db file has no turn_message table to insert into yet.
    (await openHistory({ enabled: true, dbPath, storePrompts: true })).close();
    const { default: Database } = (await import("better-sqlite3")) as unknown as {
      default: new (path: string) => {
        prepare(sql: string): { run(...args: unknown[]): unknown };
        close(): void;
      };
    };
    const db = new Database(dbPath);
    db.prepare(
      `INSERT INTO turn_message (session_id, turn_id, seq, idx, role, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("s2", "t1", 0, 0, "user", JSON.stringify([{ type: "text", text: "legacy row" }]), Date.now());
    db.close();

    const reopened = await openHistory({ enabled: true, dbPath, storePrompts: true });
    try {
      const loaded = await reopened.loadTranscript!("s2");
      expect(loaded).toHaveLength(1);
      expect(loaded[0]!.role).toBe("user");
      expect((loaded[0]!.content[0] as { text: string }).text).toBe("legacy row");
      expect(loaded[0]!.toolCallId).toBeUndefined();
    } finally {
      reopened.close();
    }
  });

  it("writes NOTHING when storePrompts is off (the default)", async () => {
    const dbPath = tmpDbPath();
    const store = await openHistory({ enabled: true, dbPath });
    try {
      store.appendTranscript!({ sessionId: "s1", turnId: "t1", seq: 0, messages: [user("secret plan")] });
      expect(await store.loadTranscript!("s1")).toEqual([]);
    } finally {
      store.close();
    }
    // Not even readable through a second, opted-in handle: it was never written.
    const reopened = await openHistory({ enabled: true, dbPath, storePrompts: true });
    try {
      expect(await reopened.loadTranscript!("s1")).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("redacts a secret pasted into a prompt before it touches disk", async () => {
    const dbPath = tmpDbPath();
    const store = await openHistory({ enabled: true, dbPath, storePrompts: true });
    try {
      store.appendTranscript!({
        sessionId: "s1",
        turnId: "t1",
        seq: 0,
        messages: [user("deploy with sk-abcdef0123456789ABCDEF please")],
      });
      const loaded = await store.loadTranscript!("s1");
      const text = (loaded[0]!.content[0] as { text: string }).text;
      expect(text).not.toContain("sk-abcdef0123456789ABCDEF");
      expect(text).toContain("deploy with");
    } finally {
      store.close();
    }
  });

  it("stores transcript rows as authenticated ciphertext by default", async () => {
    const dbPath = tmpDbPath();
    const store = await openHistory({ enabled: true, dbPath, storePrompts: true });
    store.appendTranscript!({
      sessionId: "s1",
      turnId: "t1",
      seq: 0,
      messages: [user("project codename blueberry")],
    });
    store.close();

    const { default: Database } = (await import("better-sqlite3")) as unknown as {
      default: new (path: string) => {
        prepare(sql: string): { get(): { content: string } };
        close(): void;
      };
    };
    const db = new Database(dbPath);
    const row = db.prepare("SELECT content FROM turn_message LIMIT 1").get();
    db.close();
    expect(row.content).toMatch(/^enc:v1:/);
    expect(row.content).not.toContain("blueberry");

    const reopened = await openHistory({ enabled: true, dbPath, storePrompts: true });
    expect(JSON.stringify(await reopened.loadTranscript!("s1"))).toContain("blueberry");
    reopened.close();
  });

  it("re-recording a turn REPLACES its reply instead of appending a second one", async () => {
    const dbPath = tmpDbPath();
    const store = await openHistory({ enabled: true, dbPath, storePrompts: true });
    try {
      store.appendTranscript!({ sessionId: "s1", turnId: "t1", seq: 0, messages: [user("q")] });
      store.appendTranscript!({ sessionId: "s1", turnId: "t1", seq: 1, messages: [assistant("auto-captured")] });
      store.appendTranscript!({ sessionId: "s1", turnId: "t1", seq: 1, messages: [assistant("the winner")] });

      const loaded = await store.loadTranscript!("s1");
      expect(loaded).toHaveLength(2);
      expect((loaded[1]!.content[0] as { text: string }).text).toBe("the winner");
    } finally {
      store.close();
    }
  });

  it("keeps sessions separate and reports the most recent one for --continue", async () => {
    const dbPath = tmpDbPath();
    const store = await openHistory({ enabled: true, dbPath, storePrompts: true });
    try {
      store.appendTranscript!({ sessionId: "s_old", turnId: "t1", seq: 0, messages: [user("old")] });
      store.appendTranscript!({ sessionId: "s_new", turnId: "t1", seq: 0, messages: [user("new")] });
      expect(await store.loadTranscript!("s_old")).toHaveLength(1);
    } finally {
      store.close();
    }
    expect(await latestStoredSession(dbPath)).not.toBeNull();
  });

  it("reports no resumable session when nothing was ever stored", async () => {
    const dbPath = tmpDbPath();
    const store = await openHistory({ enabled: true, dbPath, storePrompts: true });
    store.close();
    expect(await latestStoredSession(dbPath)).toBeNull();
  });
});
