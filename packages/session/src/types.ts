/**
 * Row and view types for the session package. `EventRow` / `RunSummaryRow`
 * mirror the frozen history schema (kept in sync with `@nexuscode/cli`);
 * `SessionMeta` and `SnapshotInfo` are the aggregated/sidecar views this package
 * adds on top.
 */

/** One raw event row from `event_log`. */
export interface EventRow {
  session_id: string;
  turn_id: string;
  run_id: string;
  seq: number;
  type: string;
  ts: number;
  payload: string;
}

/** One summarized run row from `run_summary`. */
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

/** Aggregated, listable view of one session. */
export interface SessionMeta {
  sessionId: string;
  /** Human-assigned name (via `name`/`rename`), if any. */
  name?: string;
  /** Earliest activity timestamp (ms since epoch). */
  createdAt: number;
  /** Latest activity timestamp (ms since epoch). */
  updatedAt: number;
  /** Adapter id of the most recent run in the session. */
  provider?: string;
  /** Model of the most recent run in the session. */
  model?: string;
  /** Distinct turns. */
  turnCount: number;
  /** Settled runs recorded for the session. */
  runCount: number;
  /** Total events persisted for the session. */
  eventCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** A captured point-in-time snapshot of a session. */
export interface SnapshotInfo {
  snapshotId: string;
  sessionId: string;
  label?: string;
  /** Highest `seq` included in the snapshot. */
  upToSeq: number;
  eventCount: number;
  createdAt: number;
}
