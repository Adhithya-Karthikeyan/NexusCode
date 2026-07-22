/**
 * TransferHandle — the concrete capture handle the agent runner attaches to a
 * RunContext. Bundles the EventProjector, DeltaSyncBus, VerbatimSink, and
 * ToolProgress over a shared db + blob store, and owns a monotonic lamport
 * clock for the run.
 *
 * Structural: this satisfies `@nexuscode/core`'s `TransferHandle` interface
 * (same shape) WITHOUT this package build-coupling to core — core defines the
 * seam in terms of `StreamChunk` only, and the CLI/engine constructs this handle
 * and sets it on `RunContext.transfer`. When `transfer` is undefined the runner
 * behaves exactly as before.
 *
 * Load-bearing invariant: every chunk the runner routes here is (a) written
 * verbatim (unredacted) to `zlcts_verbatim` and (b) projected to typed deltas
 * and folded into the PNKC via the WAL. A mid-run provider switch replays from
 * this. Tool output is captured to `zlcts_tool_progress` for mid-tool-call
 * termination resume. Turn boundaries are marked in the WAL.
 */

import type { StreamChunk } from "@nexuscode/shared";
import type { BlobStore } from "./blobs.js";
import type { DbLike } from "./migrate.js";
import type { Mutex } from "./mutex.js";
import { createDeltaSyncBus } from "./sync.js";
import { createEventProjector, PROJECTOR_VERSION } from "./projector.js";
import { createToolProgress } from "./tool-progress.js";
import { createVerbatimSink } from "./verbatim.js";
import { createDeltaWAL } from "./wal.js";
import type { EpisodicFields } from "./items.js";

/** Options for constructing a TransferHandle. */
export interface TransferHandleOptions {
  db: DbLike;
  blobs: BlobStore;
  mutex: Mutex;
  sessionId: string;
  runId: string;
  turnId: string;
}

/**
 * The runner-facing capture seam. Structurally compatible with
 * `@nexuscode/core`'s `TransferHandle` (re-declared here so this package is
 * self-contained and does not import core).
 */
export interface TransferHandle {
  readonly sessionId: string;
  /** Capture a raw, unredacted chunk BEFORE the redacting SessionStore.append. */
  captureVerbatim(chunk: StreamChunk): void;
  /** Project a chunk to typed deltas and fold them into the PNKC (WAL + items). */
  project(chunk: StreamChunk): Promise<void>;
  /** Record a completed tool's output for mid-tool-call-termination resume. */
  recordToolOutput(tool: string, stdout: string): void;
  /** Emit a turn-boundary lifecycle marker into the WAL. */
  turnBoundary(kind: "start" | "end", turn: number): Promise<void>;
  /** Durability barrier: mark the WAL durably written up to the high-water lamport. */
  flush(): void;
}

/** Create a TransferHandle bound to db + blobs + mutex for one run. */
export function createTransferHandle(opts: TransferHandleOptions): TransferHandle {
  const projector = createEventProjector();
  const syncBus = createDeltaSyncBus(opts.db, opts.blobs, opts.mutex);
  const verbatim = createVerbatimSink(opts.db, opts.blobs);
  const toolProgress = createToolProgress(opts.db, opts.blobs);
  // A separate WAL handle over the same zlcts_wal table, used only for the
  // durability barrier (flushSync). The DeltaSyncBus owns the append path;
  // both operate on the same table so the barrier reaches every folded row.
  const wal = createDeltaWAL(opts.db, opts.blobs);
  let lamport = 0;
  const nextLamport = (): number => ++lamport;

  return {
    sessionId: opts.sessionId,

    captureVerbatim(chunk) {
      verbatim.write(chunk, { sessionId: opts.sessionId, lamportTs: nextLamport() });
    },

    async project(chunk) {
      const pctx = {
        runId: opts.runId,
        turnId: opts.turnId,
        lamportTs: nextLamport(),
        projectorVersion: PROJECTOR_VERSION,
      };
      const deltas = projector.project(chunk, pctx);
      for (const d of deltas) {
        // The projector keys execution-event deltas by runId (all it has in
        // its context). Normalize to the session id so the WAL is consistently
        // session-keyed — flush/truncate/recovery operate per session. The
        // run id is still preserved on the item via fields.runId / entityId.
        if (d.op === "execution-event") d.sessionId = opts.sessionId;
        await syncBus.apply(d);
      }
    },

    recordToolOutput(tool, stdout) {
      toolProgress.append({ sessionId: opts.sessionId, turnId: opts.turnId, tool, stdout });
    },

    async turnBoundary(kind, turn) {
      const lamportTs = nextLamport();
      const action = `turn-${kind}`;
      const fields: EpisodicFields = {
        runId: opts.runId,
        turnId: opts.turnId,
        action,
        result: "unknown",
        projectorVersion: PROJECTOR_VERSION,
        deltaKids: { added: [], updated: [], invalidated: [] },
        deltaFiles: [],
        tokensIn: 0,
        tokensOut: 0,
      };
      await syncBus.apply({
        op: "execution-event",
        sessionId: opts.sessionId,
        lamportTs,
        actionId: `${action}-${lamportTs}`,
        entityId: `${opts.runId}-${lamportTs}-${action}-${turn}`,
        title: `Turn ${kind}: #${turn}`,
        body: `Turn ${kind} boundary for run ${opts.runId} (turn ${turn})`,
        fields,
      });
    },

    flush() {
      wal.flushSync(opts.sessionId, lamport);
    },
  };
}