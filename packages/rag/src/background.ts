/**
 * Background RAG indexing (system-spec §23: background indexing). Kicks off an
 * incremental (re)index WITHOUT blocking the caller: {@link BackgroundIndexer.start}
 * returns a handle synchronously while the embedding work proceeds off the hot
 * path, so `nexus index` (or an interactive session) can keep going while the
 * corpus is (re)built. Progress is reported live via the handle's {@link
 * BackgroundIndexHandle.progress} snapshot, and {@link BackgroundIndexHandle.whenDone}
 * resolves with the final {@link IncrementalIndexResult}.
 *
 * Only changed documents are embedded (same hash comparison as
 * {@link RagIndex.incrementalIndex}); each embedded document advances `done`, so a
 * caller can render a progress bar. Fully offline and deterministic.
 */

import { createHash } from "node:crypto";
import { DOC_HASH_META, type IncrementalIndexResult } from "./index-api.js";
import type { RagIndex } from "./index-api.js";
import type { RagDocument } from "./types.js";

/** Lifecycle phase of a background index run. */
export type BackgroundIndexPhase = "running" | "done" | "error";

/** A live snapshot of a background index run's progress. */
export interface BackgroundIndexProgress {
  phase: BackgroundIndexPhase;
  /** Documents that need embedding (new/changed). */
  total: number;
  /** Documents embedded so far (advances as work proceeds). */
  done: number;
  /** Documents skipped as unchanged. */
  skipped: number;
  /** Documents pruned (absent from input, when `prune` is set). */
  removed: number;
  /** Set when `phase === "error"`. */
  error?: string;
  startedAt: number;
  endedAt?: number;
}

/** Handle to an in-flight background index run. */
export interface BackgroundIndexHandle {
  /** A defensive snapshot of current progress. */
  readonly progress: BackgroundIndexProgress;
  /** Resolves with the incremental result when indexing finishes (rejects on error). */
  whenDone(): Promise<IncrementalIndexResult>;
}

export interface BackgroundIndexOptions {
  /** Remove documents that vanished from the input (default false). */
  prune?: boolean;
  /** Called after each document is embedded (for progress rendering). */
  onProgress?: (progress: BackgroundIndexProgress) => void;
}

/**
 * Runs {@link RagIndex} (re)indexing in the background. Stateless aside from the
 * per-run handle it hands back — construct once and reuse.
 */
export class BackgroundIndexer {
  /**
   * Start a non-blocking incremental (re)index of `documents` into `index`.
   * Returns immediately with a handle whose `progress` updates as work proceeds.
   */
  start(
    index: RagIndex,
    documents: RagDocument | RagDocument[],
    opts: BackgroundIndexOptions = {},
  ): BackgroundIndexHandle {
    const docs = Array.isArray(documents) ? documents : [documents];

    const progress: BackgroundIndexProgress = {
      phase: "running",
      total: 0,
      done: 0,
      skipped: 0,
      removed: 0,
      startedAt: Date.now(),
    };

    const run = async (): Promise<IncrementalIndexResult> => {
      // Diff against the stored per-document hashes (same signal as incrementalIndex).
      const storedHash = new Map<string, string>();
      for (const chunk of index.vectorStore.chunks()) {
        if (storedHash.has(chunk.docId)) continue;
        const h = chunk.meta?.[DOC_HASH_META];
        if (typeof h === "string") storedHash.set(chunk.docId, h);
      }

      const changed: RagDocument[] = [];
      const indexed: string[] = [];
      const skipped: string[] = [];
      const seen = new Set<string>();
      for (const doc of docs) {
        seen.add(doc.id);
        const hash = createHash("sha256").update(doc.text).digest("hex");
        if (storedHash.get(doc.id) === hash) {
          skipped.push(doc.id);
          continue;
        }
        changed.push({ ...doc, meta: { ...(doc.meta ?? {}), [DOC_HASH_META]: hash } });
        indexed.push(doc.id);
      }

      progress.total = changed.length;
      progress.skipped = skipped.length;

      const removed: string[] = [];
      if (opts.prune) {
        for (const docId of storedHash.keys()) {
          if (!seen.has(docId) && index.remove(docId) > 0) removed.push(docId);
        }
      }
      progress.removed = removed.length;

      // Embed one changed document at a time so `done` advances for progress
      // reporting (and peak memory stays bounded to a single document's chunks).
      for (const doc of changed) {
        await index.index(doc);
        progress.done += 1;
        opts.onProgress?.({ ...progress });
      }

      progress.phase = "done";
      progress.endedAt = Date.now();
      opts.onProgress?.({ ...progress });
      return { indexed, skipped, removed };
    };

    // Kick off without awaiting — the caller gets the handle immediately.
    const donePromise = run().catch((err: unknown) => {
      progress.phase = "error";
      progress.error = err instanceof Error ? err.message : String(err);
      progress.endedAt = Date.now();
      opts.onProgress?.({ ...progress });
      throw err;
    });
    // A caller that only polls `.progress` (and never calls `whenDone()`) must
    // never crash the process with an unhandled rejection — the error is
    // already captured on `progress.error` above. Attaching a no-op `.catch`
    // here marks THIS promise as handled without altering what `whenDone()`
    // returns: it hands back the very same `donePromise`, so a caller that DOES
    // await it still observes the rejection normally.
    donePromise.catch(() => {});

    return {
      get progress(): BackgroundIndexProgress {
        return { ...progress };
      },
      whenDone: () => donePromise,
    };
  }
}
