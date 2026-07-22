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
 * Phase 0: schema migration, SessionDb write mutex, structural db interface.
 * Phase 1: capture path — items, blobs, WAL, KG, FTS5, projector, verbatim,
 *           tool-progress, delta sync bus.
 */

// Phase 0
export type { DbLike } from "./migrate.js";
export { migrateMindDb, listMindTables, MIND_DB_VERSION } from "./migrate.js";
export { createMutex } from "./mutex.js";
export type { Mutex } from "./mutex.js";

// Phase 1 — items (the data model contract)
export type {
  ItemKind,
  Scope,
  ItemStatus,
  EdgeKind,
  Link,
  Provenance,
  Ref,
  ProbeTask,
  ExpectedAnswer,
  Reasoning,
  Verification,
  KnowledgeItem,
  DecisionOption,
  DecisionFields,
  ApproachSignature,
  FailureFields,
  TaskFields,
  Constraint,
  Preference,
  IntentFields,
  AssumptionFields,
  EpisodicFields,
  GraphNode,
  GraphEdge,
} from "./items.js";
export {
  NEVER_COMPRESS_KINDS,
  makeEmbeddingKey,
  stableFieldsOf,
  tagReasoning,
  ulid,
} from "./items.js";

// Phase 1 — blobs
export type { BlobStore } from "./blobs.js";
export { createBlobStore } from "./blobs.js";

// Phase 1 — WAL
export type { WalEntry, WalAppendResult, DeltaWAL } from "./wal.js";
export { createDeltaWAL } from "./wal.js";

// Phase 1 — deltas
export type { Delta, DeltaHandler, DeltaBus } from "./deltas.js";
export { createDeltaBus } from "./deltas.js";

// Phase 1 — store
export type { ItemStore, ListFilter } from "./store.js";
export { createItemStore } from "./store.js";

// Phase 1 — sync
export type { DeltaSyncBus } from "./sync.js";
export { createDeltaSyncBus, refold, recoverUnfolded } from "./sync.js";

// Phase 2 — snapshots (the ONLY rollback target)
export type { SnapshotRef, SnapshotRow, PnkcSnapshotStore } from "./snapshot.js";
export { createPnkcSnapshotStore } from "./snapshot.js";

// Phase 2 — integrity verification + repair
export type { IntegrityReport, RepairAction, LossEvent, IntegrityRepair } from "./integrity.js";
export { createIntegrityRepair } from "./integrity.js";

// Phase 2 — crash-recovery replay on openSessionDb (safe, idempotent WAL replay
// only; integrity check/repair is on-demand, not open-time)
export { defaultBlobDir, createSessionBlobStore, recoverMindDbOnOpen } from "./recover.js";

// Phase 1 — projector
export type { EventProjector, ProjectionContext } from "./projector.js";
export { createEventProjector, PROJECTOR_VERSION } from "./projector.js";

// Phase 1 — verbatim
export type { VerbatimSink } from "./verbatim.js";
export { createVerbatimSink } from "./verbatim.js";

// Phase 1 — tool-progress
export type { ToolProgress } from "./tool-progress.js";
export { createToolProgress } from "./tool-progress.js";

// Phase 1 — transfer handle (the runner seam; structurally satisfies core's
// TransferHandle without this package build-coupling to @nexuscode/core)
export type { TransferHandle, TransferHandleOptions } from "./handle.js";
export { createTransferHandle } from "./handle.js";