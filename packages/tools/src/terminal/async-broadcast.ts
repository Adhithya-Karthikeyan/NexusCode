/**
 * A tiny replayable, multi-consumer async broadcast used to fan out a process's
 * output. Unlike the single-consumer `AsyncQueue` in `shell.ts`, every call to
 * `iterate()` gets its own cursor and replays everything pushed so far before
 * following the live tail. This lets a caller both buffer the whole output AND
 * open one (or several) streaming async-iterables over the same source.
 */
export class AsyncBroadcast<T> {
  private readonly chunks: T[] = [];
  private readonly wakers = new Set<() => void>();
  private closed = false;

  /** Append a value and wake every parked iterator. No-op once closed. */
  push(value: T): void {
    if (this.closed) return;
    this.chunks.push(value);
    this.wake();
  }

  /** Mark the stream complete; parked iterators drain remaining values then end. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.wake();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private wake(): void {
    const pending = [...this.wakers];
    this.wakers.clear();
    for (const w of pending) w();
  }

  /** A fresh async-iterable that replays buffered values then follows the tail. */
  async *iterate(): AsyncGenerator<T> {
    let i = 0;
    for (;;) {
      while (i < this.chunks.length) yield this.chunks[i++]!;
      if (this.closed) return;
      await new Promise<void>((resolve) => this.wakers.add(resolve));
    }
  }
}
