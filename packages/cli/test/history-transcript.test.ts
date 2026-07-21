/**
 * The durable transcript table — the only place in the history db that holds the
 * user's own words. Two properties matter more than round-tripping: it is written
 * ONLY on an explicit opt-in, and what is written is redacted first.
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
