/**
 * Watch-mode repository reindexing (system-spec §23: incremental updates · watch
 * mode). Watches a directory and, after a debounced quiet window, invokes a
 * reindex callback with the set of changed paths — typically wired to an
 * {@link IncrementalRepoIndexer} so only the edited files are re-parsed.
 *
 * Raw `fs.watch` events (a single save can emit several) are coalesced by a
 * {@link ChangeBatcher}. The watcher is injectable and the handle exposes
 * {@link WatchHandle.notify}/{@link WatchHandle.flush}, so a test can trigger a
 * change and force the flush deterministically without real event timing.
 */

import { watch as fsWatch, realpathSync, type FSWatcher } from "node:fs";
import { join, sep } from "node:path";
import { ChangeBatcher } from "@nexuscode/shared";

/** A raw-event source the watcher drives; returns something closeable. */
export interface WatchSource {
  close(): void;
}

export interface WatchProjectOptions {
  /** Called once per debounced window with the distinct changed (relative) paths. */
  onReindex: (changedPaths: string[]) => void | Promise<void>;
  /** Debounce window in ms (default 150). */
  delayMs?: number;
  /** Called if `onReindex` throws (default: swallow so the watcher stays alive). */
  onError?: (err: unknown) => void;
  /**
   * Custom watcher factory (tests). Given a per-path change callback, returns a
   * closeable source. Defaults to a recursive `fs.watch` over `dir`.
   */
  watchSource?: (dir: string, onChange: (path: string) => void) => WatchSource;
}

/** Handle to a running watch loop. */
export interface WatchHandle {
  /** Feed a changed path in manually (what the watcher calls; also for tests). */
  notify(path: string): void;
  /** Force an immediate reindex of everything pending. */
  flush(): Promise<void>;
  /** Await whatever reindex the debounce timer most recently kicked off. */
  settled(): Promise<void>;
  /** The paths accumulated but not yet flushed. */
  readonly pending: string[];
  /** Stop watching and cancel any pending reindex. */
  close(): void;
}

/**
 * Guard against a symlink INSIDE the watched tree pointing OUTSIDE its root:
 * resolve `filename` (relative to `dir`) to its real path and return the
 * original `filename` only when that real path is `dir`'s real path or
 * nested under it — never following an escaping symlink into a read/parse. A
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
    watcher = undefined;
  }
  return {
    close(): void {
      watcher?.close();
    },
  };
}

/** Start watching `dir` and reindex on debounced changes. Returns a handle. */
export function watchProject(dir: string, opts: WatchProjectOptions): WatchHandle {
  const batcher = new ChangeBatcher({
    delayMs: opts.delayMs ?? 150,
    onFlush: async (paths) => {
      try {
        await opts.onReindex(paths);
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
    get pending(): string[] {
      return batcher.pending;
    },
    close: () => {
      source.close();
      batcher.close();
    },
  };
}
