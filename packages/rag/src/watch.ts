/**
 * Watch-mode RAG reindexing (system-spec §23: incremental updates · watch mode).
 *
 * Watches a directory and, after a debounced quiet window, incrementally
 * re-indexes only the documents that changed — the cheap path built on
 * {@link RagIndex.incrementalIndex} (unchanged documents are never re-embedded).
 * Raw filesystem events are coalesced by a {@link ChangeBatcher} so an editor's
 * temp-file-swap save or a bulk `git checkout` triggers one reindex, not dozens.
 *
 * The underlying watcher is injectable (default `fs.watch`) and the returned
 * handle exposes {@link WatchReindexHandle.notify} / {@link WatchReindexHandle.flush}
 * so a test can trigger a change and force the flush deterministically — no real
 * filesystem-event timing or long sleeps required.
 */

import { watch as fsWatch, realpathSync, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";
import { ChangeBatcher } from "@nexuscode/shared";
import type { IncrementalIndexResult } from "./index-api.js";
import type { RagIndex } from "./index-api.js";
import type { RagDocument } from "./types.js";

/** A raw-event source the watcher drives; returns something closeable. */
export interface WatchSource {
  close(): void;
}

export interface WatchReindexOptions {
  /** The index to keep in sync. */
  index: RagIndex;
  /**
   * Resolve the changed paths into the documents to (re)index. Return the
   * documents whose content should be compared/embedded; absent-on-disk paths
   * should simply be omitted (and handled via `prune`). Paths are relative to the
   * watched `dir` as the OS reports them.
   */
  loadDocs: (changedPaths: string[]) => Promise<RagDocument[]> | RagDocument[];
  /** Debounce window in ms before a reindex fires (default 150). */
  delayMs?: number;
  /** Remove documents no longer present (default false). */
  prune?: boolean;
  /** Called after each reindex with its result. */
  onReindex?: (result: IncrementalIndexResult) => void;
  /** Called if a reindex throws (default: swallow so the watcher stays alive). */
  onError?: (err: unknown) => void;
  /**
   * Custom watcher factory (tests). Given a per-path change callback, returns a
   * closeable source. Defaults to a recursive `fs.watch` over `dir`.
   */
  watchSource?: (dir: string, onChange: (path: string) => void) => WatchSource;
}

/** Handle to a running watch-reindex loop. */
export interface WatchReindexHandle {
  /** Feed a changed path in manually (what the watcher calls; also for tests). */
  notify(path: string): void;
  /** Force an immediate reindex of everything pending (returns when it settles). */
  flush(): Promise<void>;
  /** Await whatever reindex the debounce timer most recently kicked off. */
  settled(): Promise<void>;
  /** Stop watching and cancel any pending reindex. */
  close(): void;
}

/**
 * Guard against a symlink INSIDE the watched tree pointing OUTSIDE its root:
 * resolve `filename` (relative to `dir`) to its real path and return the
 * original `filename` only when that real path is `dir`'s real path or
 * nested under it — never following an escaping symlink into a read/embed. A
 * vanished path (deleted/renamed — nothing left to read) is passed through
 * unchanged since there is no content it could leak.
 */
export function resolveChangedPath(dir: string, filename: string): string | undefined {
  let rootReal: string;
  try {
    rootReal = realpathSync(dir);
  } catch {
    rootReal = dir;
  }
  let real: string;
  try {
    real = realpathSync(join(dir, filename));
  } catch {
    return filename;
  }
  return real === rootReal || real.startsWith(rootReal + sep) ? filename : undefined;
}

function defaultWatchSource(dir: string, onChange: (path: string) => void): WatchSource {
  let watcher: FSWatcher | undefined;
  try {
    watcher = fsWatch(dir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const rel = String(filename);
      if (resolveChangedPath(dir, rel) === undefined) return;
      onChange(rel);
    });
  } catch {
    // Watching may be unsupported for the target; the loop still works via notify().
    watcher = undefined;
  }
  return {
    close(): void {
      watcher?.close();
    },
  };
}

/**
 * Start watching `dir` and incrementally reindex on debounced changes. Returns a
 * handle; call {@link WatchReindexHandle.close} to stop.
 */
export function watchAndReindex(dir: string, opts: WatchReindexOptions): WatchReindexHandle {
  const batcher = new ChangeBatcher({
    delayMs: opts.delayMs ?? 150,
    onFlush: async (paths) => {
      try {
        const docs = await opts.loadDocs(paths);
        const result = await opts.index.incrementalIndex(docs, { prune: opts.prune ?? false });
        opts.onReindex?.(result);
      } catch (err) {
        if (opts.onError) opts.onError(err);
      }
    },
  });

  const factory = opts.watchSource ?? defaultWatchSource;
  const source = factory(dir, (path) => batcher.notify(path));

  return {
    notify: (path) => batcher.notify(path),
    flush: () => batcher.flush(),
    settled: () => batcher.settled(),
    close: () => {
      source.close();
      batcher.close();
    },
  };
}
