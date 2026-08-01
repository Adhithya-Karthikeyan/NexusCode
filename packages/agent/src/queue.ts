/**
 * A minimal single-producer / single-consumer async queue used to expose the
 * agent run's merged chunk stream as an `AsyncIterable`. Mirrors the shape the
 * kernel's orchestrator uses internally, kept local so `@nexuscode/agent` adds
 * no new export surface to core.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;
  /**
   * Whether `fail()` was ever called, tracked separately from `failure` so a
   * falsy failure value (`fail(undefined)`, `fail(0)`, `fail("")`) is still
   * recognized as a failure rather than being mistaken for "no failure set".
   */
  private failed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.resolve({ value: undefined as never, done: true });
    }
  }

  fail(err: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failed = true;
    this.failure = err;
    while (this.waiters.length > 0) {
      this.waiters.shift()!.reject(err);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.values.length > 0) {
          return Promise.resolve({ value: this.values.shift()!, done: false });
        }
        if (this.failed) return Promise.reject(this.failure);
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise<IteratorResult<T>>((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}
