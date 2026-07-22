/**
 * A minimal async serializing mutex. The ZLCTS capture path and the existing
 * `SessionStore.append` / `openHistory` writer both write to the same SQLite
 * file; routing every write through one mutex prevents `SQLITE_BUSY` and the
 * lost-update races that two independent writers would create.
 *
 * This is the single `SessionDb` write mutex (design: "single serialized write
 * queue on the one SQLite file").
 */

export interface Mutex {
  /** Run `fn` once all previously-enqueued runs have settled. Resolves with fn's value. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /**
   * Run a SYNCHRONOUS `fn` immediately. better-sqlite3 writes are synchronous,
   * so for startup-only paths (e.g. WAL recovery before any live writer exists)
   * there is no async queue to wait on — `runSync` just executes `fn` and
   * returns its value. Do NOT use `runSync` from a context that might race with
   * an in-flight `run`; it does not enqueue against the async tail. Intended for
   * single-threaded startup recovery only.
   */
  runSync<T>(fn: () => T): T;
}

/**
 * Create a mutex. Re-entrancy is NOT supported — `fn` must not re-enter the same
 * mutex. Failures in `fn` reject the returned promise but never break the chain
 * (the next queued run still executes).
 */
export function createMutex(): Mutex {
  const initialTail: Promise<unknown> = Promise.resolve();
  let tail: Promise<unknown> = initialTail;
  // `live` flips to true the moment any `run` is enqueued. `runSync` is the
  // startup-only fast path (no async queue to wait on); once a live async
  // writer exists on THIS mutex, `runSync` would risk jumping the queue and
  // hitting an open transaction, so it refuses. Pure-startup callers (WAL
  // recovery before any `apply`) never flip `live` and keep working.
  let live = false;
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      live = true;
      // `then(fn, fn)` so the next run starts whether or not the previous
      // resolved or rejected; the caller still observes fn's own outcome.
      const next = tail.then(fn, fn) as Promise<T>;
      // Keep the chain alive regardless of rejection so a failing run cannot
      // starve later waiters.
      tail = next.catch(() => undefined);
      return next;
    },
    runSync<T>(fn: () => T): T {
      // Startup-only synchronous execution. See interface doc for the contract.
      // Enforce the contract at runtime: once a live async writer has been
      // enqueued on this mutex (live=true AND tail advanced past the initial
      // resolved promise), refuse — the caller must use `run` instead.
      if (live && tail !== initialTail) {
        throw new Error(
          "mutex.runSync called with a live async writer; use run() instead",
        );
      }
      return fn();
    },
  };
}