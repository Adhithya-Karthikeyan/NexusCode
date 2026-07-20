import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:os";
import { openHistory, historyShow } from "../src/history.js";
import type { StreamChunk } from "@nexuscode/shared";

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "nx-hist-"));
  return join(dir, "sub", "history.db");
}

describe("history store — raw field stripping", () => {
  it("strips `raw` from a persisted chunk's payload", async () => {
    const dbPath = tmpDbPath();
    const store = await openHistory({ enabled: true, dbPath });
    try {
      const chunk = {
        type: "tool-call-start",
        runId: "run_1",
        id: "tool_1",
        name: "shell",
        raw: { sensitive: "provider-internal-blob" },
      } as unknown as StreamChunk;

      store.append({ sessionId: "sess_1", turnId: "turn_1", runId: "run_1", seq: 1, chunk });

      const events = await historyShow(dbPath, "run_1");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(payload).not.toHaveProperty("raw");
      expect(JSON.stringify(payload)).not.toContain("provider-internal-blob");
      // Non-raw fields are preserved.
      expect(payload["type"]).toBe("tool-call-start");
      expect(payload["name"]).toBe("shell");
    } finally {
      store.close();
    }
  });

  it("redacts a known secret value inside a tool-result chunk's content before persisting", async () => {
    const dbPath = tmpDbPath();
    const store = await openHistory({ enabled: true, dbPath });
    try {
      const chunk = {
        type: "tool-result",
        runId: "run_3",
        toolCallId: "tool_3",
        content: [{ type: "text", text: "here is the key: sk-abcdef0123456789ABCDEF" }],
      } as unknown as StreamChunk;

      store.append({ sessionId: "sess_3", turnId: "turn_3", runId: "run_3", seq: 1, chunk });

      const events = await historyShow(dbPath, "run_3");
      expect(events).toHaveLength(1);
      const raw = events[0]!.payload;
      expect(raw).not.toContain("sk-abcdef0123456789ABCDEF");
      const payload = JSON.parse(raw) as { content: { type: string; text: string }[] };
      expect(payload.content[0]!.text).toContain("[REDACTED]");
      expect(payload.content[0]!.text).toContain("here is the key:");
    } finally {
      store.close();
    }
  });

  it("does not choke on chunks with no `raw` field", async () => {
    const dbPath = tmpDbPath();
    const store = await openHistory({ enabled: true, dbPath });
    try {
      const chunk = { type: "run-start", runId: "run_2", adapterId: "mock", model: "mock-fast", ts: Date.now() } as StreamChunk;
      store.append({ sessionId: "sess_2", turnId: "turn_2", runId: "run_2", seq: 1, chunk });
      const events = await historyShow(dbPath, "run_2");
      expect(events).toHaveLength(1);
      const payload = JSON.parse(events[0]!.payload) as Record<string, unknown>;
      expect(payload["type"]).toBe("run-start");
    } finally {
      store.close();
    }
  });
});

describe("history store — file permissions", () => {
  // Windows does not model POSIX permission bits the same way; this hardening
  // targets POSIX platforms.
  const itPosix = platform() === "win32" ? it.skip : it;

  itPosix("creates the data directory 0700 and the db file 0600", async () => {
    const dbPath = tmpDbPath();
    const store = await openHistory({ enabled: true, dbPath });
    try {
      expect(existsSync(dbPath)).toBe(true);
      const dirMode = statSync(join(dbPath, "..")).mode & 0o777;
      expect(dirMode).toBe(0o700);
      const fileMode = statSync(dbPath).mode & 0o777;
      expect(fileMode).toBe(0o600);
    } finally {
      store.close();
    }
  });
});
