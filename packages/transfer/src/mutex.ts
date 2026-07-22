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
}

/**
 * Create a mutex. Re-entrancy is NOT supported — `fn` must not re-enter the same
 * mutex. Failures in `fn` reject the returned promise but never break the chain
 * (the next queued run still executes).
 */
export function createMutex(): Mutex {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      // `then(fn, fn)` so the next run starts whether or not the previous
      // resolved or rejected; the caller still observes fn's own outcome.
      const next = tail.then(fn, fn) as Promise<T>;
      // Keep the chain alive regardless of rejection so a failing run cannot
      // starve later waiters.
      tail = next.catch(() => undefined);
      return next;
    },
  };
}