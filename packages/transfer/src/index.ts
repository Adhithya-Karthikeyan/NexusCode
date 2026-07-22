/**
 * @nexuscode/transfer — Zero-Loss Context Transfer System (ZLCTS).
 *
 * The harness — not the LLM — owns project knowledge in a provider-neutral
 * knowledge core (PNKC). A provider is a disposable execution engine that emits
 * validated deltas; the harness folds them back. Switching providers (auto on
 * rate-limit/failover, or `--resume` into a different provider) loses virtually
 * no understanding because everything important is externalized here, not in
 * conversation history.
 *
 * Phase 0 (this export surface) ships the schema migration, the SessionDb write
 * mutex, and the structural db interface. Capture (WAL/items/verbatim), rollback
 * (snapshots/integrity), packaging (handoff state machine), and validation land
 * in later phases.
 */

export type { DbLike } from "./migrate.js";
export { migrateMindDb, listMindTables, MIND_DB_VERSION } from "./migrate.js";
export { createMutex } from "./mutex.js";
export type { Mutex } from "./mutex.js";