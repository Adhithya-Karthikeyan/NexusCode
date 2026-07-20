/**
 * @nexuscode/session — session management over the shared SQLite event_log
 * (spec §10) plus the flagship, private-by-default Code Receipt (spec §26).
 *
 * The event_log is the single source of truth: this package lists, shows,
 * names, branches, snapshots, replays, and exports sessions from it, and can
 * render a coding session into a self-contained local HTML receipt. Nothing here
 * uploads, publishes, or otherwise leaves the machine.
 */

export { SessionStore } from "./store.js";
export type { BranchOptions, ReceiptOptions } from "./store.js";
export { openSessionDb } from "./db.js";
export type { SqliteDb, SqliteStmt } from "./db.js";
export { replayEvents, rowToChunk } from "./replay.js";
export {
  renderExport,
  toJson,
  toMarkdown,
  toHtml,
  type ExportFormat,
  type SessionBundle,
} from "./export.js";
export {
  renderReceipt,
  writeReceipt,
  type ReceiptData,
  type ReceiptTestResult,
} from "./receipt.js";
export { escapeHtml, htmlDocument, renderDiff } from "./html.js";
export type { EventRow, RunSummaryRow, SessionMeta, SnapshotInfo } from "./types.js";
