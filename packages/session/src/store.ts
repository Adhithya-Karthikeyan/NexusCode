/**
 * `SessionStore` — the session-management API over the shared SQLite event_log.
 *
 * The event_log (append-only `StreamChunk`s) + run_summary tables are the single
 * source of truth; this store reads them back to list/show/replay/export
 * sessions, and writes only additive rows: a name into `session_meta`, a cursor
 * into `session_snapshot`, or copied events under a new `session_id` when
 * branching. It also implements `@nexuscode/core`'s `EventStore`, so the same
 * object can record a live run and later manage it — which is exactly how the
 * tests seed a session (real writes into the real schema).
 */

import { randomUUID } from "node:crypto";
import type { EventStore, RunResult, StreamChunk } from "@nexuscode/core";
import type { ContentBlock } from "@nexuscode/shared";
import { redactArgs } from "@nexuscode/tools";
import { openSessionDb, type SqliteDb, type SqliteStmt } from "./db.js";
import { replayEvents, rowToChunk } from "./replay.js";
import {
  renderExport,
  type ExportFormat,
  type SessionBundle,
} from "./export.js";
import {
  writeReceipt,
  type ReceiptData,
  type ReceiptTestResult,
} from "./receipt.js";
import type { EventRow, RunSummaryRow, SessionMeta, SnapshotInfo } from "./types.js";

/** Options accepted when branching/forking a session. */
export interface BranchOptions {
  /** Include events only up to (and including) this bus `seq`. */
  upToSeq?: number;
  /** Include events up to (and including) the last event of this turn. */
  upToTurn?: string;
  /** Name to assign the new branched session. */
  name?: string;
  /** Explicit id for the new session (defaults to a fresh uuid). */
  newSessionId?: string;
}

/** Options for generating a Code Receipt. */
export interface ReceiptOptions {
  /** The originating coding prompt. Overrides any stored prompt. */
  prompt?: string;
  /** Explicit test result. Overrides auto-detection from the event stream. */
  testResult?: ReceiptTestResult;
  /** Where to write the file (defaults to the OS temp dir). */
  outDir?: string;
  fileName?: string;
  brand?: string;
  title?: string;
}

const TEST_CMD = /\b(vitest|jest|pytest|npm(\s+run)?\s+t(est)?|yarn\s+test|pnpm(\s+run)?\s+test|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test)\b/i;
const SHELL_TOOL = /^(shell|shell[_-]?exec|bash|sh|run[_-]?command)$/i;

export class SessionStore implements EventStore {
  private readonly insertEvent: SqliteStmt;
  private readonly upsertSummary: SqliteStmt;

  private constructor(private readonly db: SqliteDb) {
    this.insertEvent = db.prepare(
      `INSERT INTO event_log (session_id, turn_id, run_id, seq, type, ts, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    this.upsertSummary = db.prepare(
      `INSERT INTO run_summary
         (run_id, session_id, turn_id, adapter_id, model, status, finish_reason,
          text, input_tokens, output_tokens, cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET
         status=excluded.status, finish_reason=excluded.finish_reason, text=excluded.text,
         input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
         cost_usd=excluded.cost_usd`,
    );
  }

  /** Open (or create) a session store over `dbPath` (`:memory:` allowed). */
  static async open(dbPath: string): Promise<SessionStore> {
    const db = await openSessionDb(dbPath);
    return new SessionStore(db);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  // ── EventStore (write side) ────────────────────────────────────────────────

  /** Append one persisted `StreamChunk`. Mirrors the CLI history writer: strips
   *  the `raw` passthrough and redacts secret-shaped tool-result content. */
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
    const { raw: _raw, ...chunkWithoutRaw } = entry.chunk as StreamChunk & { raw?: unknown };
    let toStore: StreamChunk = chunkWithoutRaw as StreamChunk;
    if (toStore.type === "tool-result") {
      toStore = { ...toStore, content: redactArgs(toStore.content) as ContentBlock[] };
    }
    this.insertEvent.run(
      entry.sessionId,
      entry.turnId,
      entry.runId,
      entry.seq,
      entry.chunk.type,
      ts,
      JSON.stringify(toStore),
    );
  }

  summarize(result: RunResult & { sessionId: string; turnId: string }): void {
    this.upsertSummary.run(
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
  }

  // ── Read side ──────────────────────────────────────────────────────────────

  /** Every event of a session, in bus `seq` order. */
  eventsOf(sessionId: string): EventRow[] {
    return this.db
      .prepare(
        `SELECT session_id, turn_id, run_id, seq, type, ts, payload
         FROM event_log WHERE session_id = ? ORDER BY seq ASC`,
      )
      .all(sessionId) as EventRow[];
  }

  /** Settled run rows of a session, newest first. */
  runsOf(sessionId: string): RunSummaryRow[] {
    return this.db
      .prepare(
        `SELECT run_id, session_id, turn_id, adapter_id, model, status, finish_reason,
                text, input_tokens, output_tokens, cost_usd, created_at
         FROM run_summary WHERE session_id = ? ORDER BY created_at DESC`,
      )
      .all(sessionId) as RunSummaryRow[];
  }

  /** Aggregate one session into its listable metadata, or null if unknown. */
  getSession(sessionId: string): SessionMeta | null {
    const agg = this.db
      .prepare(
        `SELECT MIN(ts) AS first_ts, MAX(ts) AS last_ts,
                COUNT(*) AS event_count, COUNT(DISTINCT turn_id) AS turn_count
         FROM event_log WHERE session_id = ?`,
      )
      .get(sessionId) as
      | { first_ts: number | null; last_ts: number | null; event_count: number; turn_count: number }
      | undefined;
    const runAgg = this.db
      .prepare(
        `SELECT COUNT(*) AS run_count, COALESCE(SUM(input_tokens),0) AS in_tok,
                COALESCE(SUM(output_tokens),0) AS out_tok,
                COALESCE(SUM(COALESCE(cost_usd,0)),0) AS cost, MIN(created_at) AS created
         FROM run_summary WHERE session_id = ?`,
      )
      .get(sessionId) as
      | { run_count: number; in_tok: number; out_tok: number; cost: number; created: number | null }
      | undefined;

    const hasEvents = (agg?.event_count ?? 0) > 0;
    const hasRuns = (runAgg?.run_count ?? 0) > 0;
    if (!hasEvents && !hasRuns) return null;

    const latest = this.db
      .prepare(
        `SELECT adapter_id, model FROM run_summary WHERE session_id = ?
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionId) as { adapter_id: string; model: string } | undefined;
    const meta = this.db
      .prepare(`SELECT name FROM session_meta WHERE session_id = ?`)
      .get(sessionId) as { name: string | null } | undefined;

    const createdCandidates = [runAgg?.created ?? null, agg?.first_ts ?? null].filter(
      (v): v is number => typeof v === "number",
    );
    const createdAt = createdCandidates.length ? Math.min(...createdCandidates) : Date.now();
    const updatedAt = agg?.last_ts ?? createdAt;

    const out: SessionMeta = {
      sessionId,
      createdAt,
      updatedAt,
      turnCount: agg?.turn_count ?? 0,
      runCount: runAgg?.run_count ?? 0,
      eventCount: agg?.event_count ?? 0,
      inputTokens: runAgg?.in_tok ?? 0,
      outputTokens: runAgg?.out_tok ?? 0,
      costUsd: runAgg?.cost ?? 0,
    };
    if (meta?.name) out.name = meta.name;
    if (latest?.adapter_id) out.provider = latest.adapter_id;
    if (latest?.model) out.model = latest.model;
    return out;
  }

  /** List all sessions, newest activity first. */
  listSessions(): SessionMeta[] {
    const ids = this.db
      .prepare(
        `SELECT session_id FROM event_log
         UNION
         SELECT session_id FROM run_summary`,
      )
      .all() as { session_id: string }[];
    const metas: SessionMeta[] = [];
    for (const { session_id } of ids) {
      const m = this.getSession(session_id);
      if (m) metas.push(m);
    }
    metas.sort((a, b) => b.updatedAt - a.updatedAt);
    return metas;
  }

  /** Load everything needed to render/replay a session. */
  loadBundle(sessionId: string): SessionBundle | null {
    const meta = this.getSession(sessionId);
    if (!meta) return null;
    const events = this.eventsOf(sessionId);
    return {
      meta,
      events,
      runs: this.runsOf(sessionId),
      timeline: replayEvents(events),
    };
  }

  /** Re-materialize a session into its `UiEvent` timeline. */
  replay(sessionId: string) {
    return replayEvents(this.eventsOf(sessionId));
  }

  // ── Naming ─────────────────────────────────────────────────────────────────

  /** Assign (or overwrite) a session's human name. Also usable to rename. */
  name(sessionId: string, name: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO session_meta (session_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at`,
      )
      .run(sessionId, name, now, now);
  }

  /** Alias of {@link name}, for read-clarity at call sites. */
  rename(sessionId: string, name: string): void {
    this.name(sessionId, name);
  }

  /** Store the originating prompt for a session (used by the Code Receipt). */
  setPrompt(sessionId: string, prompt: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO session_meta (session_id, prompt, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET prompt=excluded.prompt, updated_at=excluded.updated_at`,
      )
      .run(sessionId, prompt, now, now);
  }

  private storedPrompt(sessionId: string): string | undefined {
    const row = this.db
      .prepare(`SELECT prompt FROM session_meta WHERE session_id = ?`)
      .get(sessionId) as { prompt: string | null } | undefined;
    return row?.prompt ?? undefined;
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  /** Delete a session entirely: its events, run rows, name, and snapshots. */
  delete(sessionId: string): void {
    const tx = this.db.transaction((id: string) => {
      this.db.prepare(`DELETE FROM event_log WHERE session_id = ?`).run(id);
      this.db.prepare(`DELETE FROM run_summary WHERE session_id = ?`).run(id);
      this.db.prepare(`DELETE FROM session_meta WHERE session_id = ?`).run(id);
      this.db.prepare(`DELETE FROM session_snapshot WHERE session_id = ?`).run(id);
    });
    tx(sessionId);
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  /** Capture a point-in-time snapshot (a cursor over the append-only log). */
  snapshot(sessionId: string, label?: string): SnapshotInfo {
    const cur = this.db
      .prepare(
        `SELECT COALESCE(MAX(seq), -1) AS max_seq, COUNT(*) AS n
         FROM event_log WHERE session_id = ?`,
      )
      .get(sessionId) as { max_seq: number; n: number };
    const snapshotId = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO session_snapshot (snapshot_id, session_id, label, up_to_seq, event_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(snapshotId, sessionId, label ?? null, cur.max_seq, cur.n, now);
    const info: SnapshotInfo = {
      snapshotId,
      sessionId,
      upToSeq: cur.max_seq,
      eventCount: cur.n,
      createdAt: now,
    };
    if (label) info.label = label;
    return info;
  }

  /** List a session's snapshots, newest first. */
  listSnapshots(sessionId: string): SnapshotInfo[] {
    const rows = this.db
      .prepare(
        `SELECT snapshot_id, session_id, label, up_to_seq, event_count, created_at
         FROM session_snapshot WHERE session_id = ? ORDER BY created_at DESC`,
      )
      .all(sessionId) as {
      snapshot_id: string;
      session_id: string;
      label: string | null;
      up_to_seq: number;
      event_count: number;
      created_at: number;
    }[];
    return rows.map((r) => {
      const info: SnapshotInfo = {
        snapshotId: r.snapshot_id,
        sessionId: r.session_id,
        upToSeq: r.up_to_seq,
        eventCount: r.event_count,
        createdAt: r.created_at,
      };
      if (r.label) info.label = r.label;
      return info;
    });
  }

  // ── Branch / fork ─────────────────────────────────────────────────────────────

  /**
   * Fork a new session seeded from a prior one's events. Events are copied into
   * the event_log under a fresh `session_id` (run ids remapped so run_summary
   * rows stay unique), optionally truncated at a `seq`/turn boundary. Returns the
   * new session id.
   */
  branch(sourceSessionId: string, opts: BranchOptions = {}): string {
    const newSessionId = opts.newSessionId ?? randomUUID();

    let cutoff = opts.upToSeq ?? Number.POSITIVE_INFINITY;
    if (opts.upToTurn !== undefined) {
      const row = this.db
        .prepare(
          `SELECT COALESCE(MAX(seq), -1) AS max_seq FROM event_log
           WHERE session_id = ? AND turn_id = ?`,
        )
        .get(sourceSessionId, opts.upToTurn) as { max_seq: number };
      cutoff = Math.min(cutoff, row.max_seq);
    }

    const source = this.eventsOf(sourceSessionId).filter((e) => e.seq <= cutoff);
    const runIdMap = new Map<string, string>();
    for (const e of source) {
      if (!runIdMap.has(e.run_id)) runIdMap.set(e.run_id, randomUUID());
    }

    const tx = this.db.transaction(() => {
      for (const e of source) {
        const newRunId = runIdMap.get(e.run_id) as string;
        this.insertEvent.run(
          newSessionId,
          e.turn_id,
          newRunId,
          e.seq,
          e.type,
          e.ts,
          e.payload,
        );
      }
      // Copy the settled run rows so the fork lists with the same cost/model.
      const runs = this.runsOf(sourceSessionId).filter((r) => runIdMap.has(r.run_id));
      for (const r of runs) {
        this.upsertSummary.run(
          runIdMap.get(r.run_id) as string,
          newSessionId,
          r.turn_id,
          r.adapter_id,
          r.model,
          r.status,
          r.finish_reason,
          r.text,
          r.input_tokens,
          r.output_tokens,
          r.cost_usd,
          r.created_at,
        );
      }
    });
    tx();

    if (opts.name) this.name(newSessionId, opts.name);
    const prompt = this.storedPrompt(sourceSessionId);
    if (prompt) this.setPrompt(newSessionId, prompt);
    return newSessionId;
  }

  // ── Export ───────────────────────────────────────────────────────────────────

  /** Render a session in the given format (`json` | `markdown` | `html`). */
  export(sessionId: string, format: ExportFormat): string | null {
    const bundle = this.loadBundle(sessionId);
    if (!bundle) return null;
    return renderExport(bundle, format);
  }

  // ── Code Receipt ─────────────────────────────────────────────────────────────

  /**
   * Detect a real test/CI result from the session's tool activity: the last
   * shell tool call whose command looks like a test run, and whether its result
   * was an error. Returns undefined when no such call exists — so the receipt
   * badge only appears for genuine results.
   */
  private detectTestResult(events: EventRow[]): ReceiptTestResult | undefined {
    const callName = new Map<string, string>();
    const callCmd = new Map<string, string>();
    let found: ReceiptTestResult | undefined;

    const commandOf = (input: unknown): string => {
      if (typeof input === "string") return input;
      if (input && typeof input === "object") {
        const o = input as Record<string, unknown>;
        for (const k of ["command", "cmd", "script", "args"]) {
          const v = o[k];
          if (typeof v === "string") return v;
          if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join(" ");
        }
      }
      return "";
    };
    const textOfContent = (content: ContentBlock[] | undefined): string => {
      if (!Array.isArray(content)) return "";
      let out = "";
      for (const b of content) {
        if (b.type === "text") out += b.text;
        else if (b.type === "tool_result") out += textOfContent(b.content);
      }
      return out;
    };

    for (const row of events) {
      const chunk = rowToChunk(row);
      if (!chunk) continue;
      if (chunk.type === "tool-call-start") {
        callName.set(chunk.id, chunk.name);
      } else if (chunk.type === "tool-call-end") {
        callCmd.set(chunk.id, commandOf(chunk.input));
      } else if (chunk.type === "tool-result") {
        const name = callName.get(chunk.toolCallId) ?? "";
        const cmd = callCmd.get(chunk.toolCallId) ?? "";
        const isTest = TEST_CMD.test(cmd) || (SHELL_TOOL.test(name) && TEST_CMD.test(cmd));
        if (!isTest) continue;
        const passed = chunk.isError !== true;
        const raw = textOfContent(chunk.content).trim();
        const summary = raw ? raw.slice(0, 240) : passed ? "Tests passed." : "Tests failed.";
        // Keep the last test result in the session as authoritative.
        found = cmd ? { passed, summary, command: cmd } : { passed, summary };
      }
    }
    return found;
  }

  /**
   * Generate a LOCAL, PRIVATE Code Receipt for a coding session and write it to
   * disk. Returns the file path and the HTML (no upload/sharing — the path is
   * yours to open). Every field is redaction-passed and HTML-escaped by the
   * renderer; the "tests passed" badge appears only when a real result exists.
   */
  generateReceipt(sessionId: string, opts: ReceiptOptions = {}): { path: string; html: string } | null {
    const bundle = this.loadBundle(sessionId);
    if (!bundle) return null;

    // Final patch per file, in first-seen order.
    const byPath = new Map<string, string>();
    for (const ev of bundle.timeline) {
      if (ev.t === "diff") byPath.set(ev.path, ev.patch);
    }
    const diffs = [...byPath.entries()].map(([path, patch]) => ({ path, patch }));

    const testResult = opts.testResult ?? this.detectTestResult(bundle.events);
    const prompt = opts.prompt ?? this.storedPrompt(sessionId) ?? "";

    const data: ReceiptData = { meta: bundle.meta, prompt, diffs };
    if (testResult) data.testResult = testResult;
    if (opts.brand !== undefined) data.brand = opts.brand;
    if (opts.title !== undefined) data.title = opts.title;

    const writeOpts: { outDir?: string; fileName?: string } = {};
    if (opts.outDir !== undefined) writeOpts.outDir = opts.outDir;
    if (opts.fileName !== undefined) writeOpts.fileName = opts.fileName;
    return writeReceipt(data, writeOpts);
  }
}
