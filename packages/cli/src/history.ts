/**
 * SQLite history — the single auditable timeline (plan §5.2). Two tables:
 * `event_log` (append-only, every `StreamChunk` with its bus `seq`) and
 * `run_summary` (one row per settled run). Secrets never reach here: chunks
 * carry no key material, and we persist only the normalized union.
 *
 * `better-sqlite3` is a native module; if it cannot load (unusual platform,
 * missing build) we degrade to a no-op store rather than crash the CLI.
 */

import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { EventStore, RunResult, StreamChunk } from "@nexuscode/core";
import { redactArgs } from "@nexuscode/tools";
import type { ContentBlock, Message } from "@nexuscode/shared";
import { migrateMindDb } from "@nexuscode/transfer";

interface SqliteStmt {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}

interface SqliteDb {
  exec(sql: string): unknown;
  prepare(sql: string): SqliteStmt;
  close(): void;
}

/** One summarized run row, as surfaced by `nexus history list`. */
export interface RunSummaryRow {
  run_id: string;
  session_id: string;
  turn_id: string;
  adapter_id: string;
  model: string;
  status: string;
  finish_reason: string | null;
  text: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  created_at: number;
}

/** One raw event row, as surfaced by `nexus history show`. */
export interface EventRow {
  session_id: string;
  turn_id: string;
  run_id: string;
  seq: number;
  type: string;
  ts: number;
  payload: string;
}

export interface HistoryStore extends EventStore {
  close(): void;
}

/**
 * Redact secret-shaped substrings out of a tool result's content blocks before
 * it is ever persisted. Tool results (`fs_read` file contents, `shell_exec`
 * stdout/stderr, …) can legitimately contain a live credential the model just
 * read or printed — the same redaction pass used for approval/audit logging
 * (`redactArgs`, see `@nexuscode/tools`) runs here too, so history/trace never
 * store what an approval prompt wouldn't have shown either.
 */
function redactToolResultContent(chunk: StreamChunk): StreamChunk {
  if (chunk.type !== "tool-result") return chunk;
  return { ...chunk, content: redactArgs(chunk.content) as ContentBlock[] };
}

const NOOP_STORE: HistoryStore = {
  append() {
    /* history disabled */
  },
  summarize() {
    /* history disabled */
  },
  close() {
    /* nothing to close */
  },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS event_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  run_id      TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  type        TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  payload     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_log_session ON event_log(session_id, seq);

CREATE TABLE IF NOT EXISTS run_summary (
  run_id        TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL,
  turn_id       TEXT NOT NULL,
  adapter_id    TEXT NOT NULL,
  model         TEXT NOT NULL,
  status        TEXT NOT NULL,
  finish_reason TEXT,
  text          TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd      REAL,
  created_at    INTEGER NOT NULL
);

-- The resumable conversation. This is the ONLY table holding the user's own
-- words, which is why it is written only when history.storePrompts is on.
CREATE TABLE IF NOT EXISTS turn_message (
  session_id  TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  idx         INTEGER NOT NULL,
  role        TEXT NOT NULL,
  content     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq, idx)
);
CREATE INDEX IF NOT EXISTS idx_turn_message_session ON turn_message(session_id, seq, idx);
`;

/**
 * Open a SQLite-backed history store. `enabled=false` (or a native-load failure)
 * yields a no-op store. `dbPath` of `:memory:` is honored for tests.
 */
export async function openHistory(opts: {
  enabled: boolean;
  dbPath: string;
  /**
   * Persist user prompts so a conversation can be resumed later. OFF unless the
   * caller passes `true` (config `history.storePrompts`) — see the schema doc:
   * everything else in this db is provider output, and what the user typed is
   * only written on an explicit opt-in.
   */
  storePrompts?: boolean;
}): Promise<HistoryStore> {
  if (!opts.enabled) return NOOP_STORE;

  let Database: new (path: string) => SqliteDb;
  try {
    const mod = (await import("better-sqlite3")) as unknown as {
      default: new (path: string) => SqliteDb;
    };
    Database = mod.default;
  } catch {
    return NOOP_STORE;
  }

  if (opts.dbPath !== ":memory:") {
    try {
      mkdirSync(dirname(opts.dbPath), { recursive: true, mode: 0o700 });
    } catch {
      return NOOP_STORE;
    }
  }

  let db: SqliteDb;
  try {
    db = new Database(opts.dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec(SCHEMA);
    // ZLCTS knowledge-core tables (additive, idempotent). Non-fatal: a failed
    // mind migration degrades to history-only and never crashes a run.
    try {
      migrateMindDb(db);
    } catch {
      /* best-effort: keep history working even if zlcts tables cannot be created */
    }
  } catch {
    return NOOP_STORE;
  }

  if (opts.dbPath !== ":memory:") {
    for (const p of [opts.dbPath, `${opts.dbPath}-wal`, `${opts.dbPath}-shm`]) {
      try {
        if (existsSync(p)) chmodSync(p, 0o600);
      } catch {
        /* best-effort: a missing/unchmoddable sibling should not crash history */
      }
    }
  }

  const insertEvent = db.prepare(
    `INSERT INTO event_log (session_id, turn_id, run_id, seq, type, ts, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const upsertSummary = db.prepare(
    `INSERT INTO run_summary
       (run_id, session_id, turn_id, adapter_id, model, status, finish_reason,
        text, input_tokens, output_tokens, cost_usd, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       status=excluded.status, finish_reason=excluded.finish_reason, text=excluded.text,
       input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
       cost_usd=excluded.cost_usd`,
  );

  const clearTranscriptSeq = db.prepare(
    `DELETE FROM turn_message WHERE session_id = ? AND seq = ?`,
  );
  const insertTranscript = db.prepare(
    `INSERT INTO turn_message (session_id, turn_id, seq, idx, role, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectTranscript = db.prepare(
    `SELECT role, content FROM turn_message WHERE session_id = ? ORDER BY seq ASC, idx ASC`,
  );

  return {
    append(entry: {
      sessionId: string;
      turnId: string;
      runId: string;
      seq: number;
      chunk: StreamChunk;
    }): void {
      const ts =
        "ts" in entry.chunk && typeof (entry.chunk as { ts?: number }).ts === "number"
          ? (entry.chunk as { ts: number }).ts
          : Date.now();
      // Strip the untranslated-provider-event `raw` passthrough before it lands
      // in the audit log — it can carry far more than we've normalized (and
      // isn't part of the stable StreamChunk contract), across every provider.
      const { raw: _raw, ...chunkWithoutRaw } = entry.chunk as StreamChunk & { raw?: unknown };
      // Then redact any secret-shaped content a tool result carries (fs_read
      // contents, shell stdout/stderr, …) before it is durably persisted.
      const redacted = redactToolResultContent(chunkWithoutRaw as StreamChunk);
      insertEvent.run(
        entry.sessionId,
        entry.turnId,
        entry.runId,
        entry.seq,
        entry.chunk.type,
        ts,
        JSON.stringify(redacted),
      );
    },
    summarize(result: RunResult & { sessionId: string; turnId: string }): void {
      upsertSummary.run(
        result.runId,
        result.sessionId,
        result.turnId,
        result.adapterId,
        result.model,
        result.status,
        result.finishReason ?? null,
        result.text,
        result.usage.inputTokens,
        result.usage.outputTokens,
        result.usage.costUsd ?? null,
        Date.now(),
      );
    },
    appendTranscript(entry: {
      sessionId: string;
      turnId: string;
      seq: number;
      messages: Message[];
    }): void {
      // Opt-in only. Without it the table stays empty and `--resume` reports that
      // honestly, rather than the user's prompts landing on disk unasked.
      if (!opts.storePrompts) return;
      const now = Date.now();
      // Replace, so a turn re-recorded with its winning answer supersedes the
      // auto-captured one instead of stacking a second reply.
      clearTranscriptSeq.run(entry.sessionId, entry.seq);
      for (let idx = 0; idx < entry.messages.length; idx++) {
        const message = entry.messages[idx]!;
        // A prompt can contain a pasted key. Same redaction pass tool results
        // get — nothing secret-shaped is written in the clear.
        const content = redactArgs(message.content) as ContentBlock[];
        insertTranscript.run(
          entry.sessionId,
          entry.turnId,
          entry.seq,
          idx,
          message.role,
          JSON.stringify(content),
          now,
        );
      }
    },
    loadTranscript(sessionId: string): Message[] {
      if (!opts.storePrompts) return [];
      try {
        const rows = selectTranscript.all(sessionId) as { role: string; content: string }[];
        const out: Message[] = [];
        for (const row of rows) {
          try {
            out.push({ role: row.role as Message["role"], content: JSON.parse(row.content) as ContentBlock[] });
          } catch {
            /* skip an unparseable row rather than fail the whole resume */
          }
        }
        return out;
      } catch {
        return [];
      }
    },
    close(): void {
      try {
        db.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** Open the history db read-only for queries. Returns null if unavailable. */
async function openReadonly(dbPath: string): Promise<SqliteDb | null> {
  let Database: new (path: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => SqliteDb;
  try {
    const mod = (await import("better-sqlite3")) as unknown as {
      default: new (path: string, opts?: { readonly?: boolean; fileMustExist?: boolean }) => SqliteDb;
    };
    Database = mod.default;
  } catch {
    return null;
  }
  try {
    return new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

/**
 * The most recently used session that has a STORED TRANSCRIPT (drives
 * `chat --continue`). Returns null when nothing was stored — which the caller
 * must surface, since the usual cause is `history.storePrompts` being off.
 */
export async function latestStoredSession(dbPath: string): Promise<string | null> {
  const db = await openReadonly(dbPath);
  if (!db) return null;
  try {
    const row = db
      .prepare(
        `SELECT session_id FROM turn_message
         GROUP BY session_id ORDER BY MAX(created_at) DESC LIMIT 1`,
      )
      .get() as { session_id?: string } | undefined;
    return row?.session_id ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Most recent settled runs, newest first (for `history list`). */
export async function historyList(dbPath: string, limit = 20): Promise<RunSummaryRow[]> {
  const db = await openReadonly(dbPath);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT run_id, session_id, turn_id, adapter_id, model, status, finish_reason,
                text, input_tokens, output_tokens, cost_usd, created_at
         FROM run_summary ORDER BY created_at DESC LIMIT ?`,
      )
      .all(limit) as RunSummaryRow[];
    return rows;
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * All logged events for a run (`history show <runId>`). If `id` matches no run
 * it is treated as a session id and every event in that session is returned, in
 * bus `seq` order.
 */
export async function historyShow(dbPath: string, id: string): Promise<EventRow[]> {
  const db = await openReadonly(dbPath);
  if (!db) return [];
  try {
    const byRun = db
      .prepare(
        `SELECT session_id, turn_id, run_id, seq, type, ts, payload
         FROM event_log WHERE run_id = ? ORDER BY seq ASC`,
      )
      .all(id) as EventRow[];
    if (byRun.length > 0) return byRun;
    return db
      .prepare(
        `SELECT session_id, turn_id, run_id, seq, type, ts, payload
         FROM event_log WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(id) as EventRow[];
  } catch {
    return [];
  } finally {
    db.close();
  }
}
