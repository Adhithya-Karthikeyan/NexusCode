/**
 * Tiny building blocks the facade uses for eventing:
 *
 *  - `Broadcast` — a *replay* fan-out over a single-consumer async iterable
 *    (the engine's `OrchestrationHandle.events()` queue can only be iterated
 *    once). It eagerly drains the source into a buffer and lets any number of
 *    late subscribers each replay the full stream, so a caller can stream text
 *    AND await the settled result off the same run without a second dispatch.
 *
 *  - `Emitter` — a minimal typed pub/sub the `Nexus` uses for `on(...)` and the
 *    async `stream(...)`; every run's chunks/UiEvents and the engine's trace
 *    events are fed through it so a consumer sees the whole embedded process.
 */

/** Unsubscribe handle returned by every `on(...)` registration. */
export type Unsubscribe = () => void;

/**
 * Replay fan-out over a single-pass async iterable. Starts reading the source
 * immediately; each `subscribe()` replays from the beginning, then follows live.
 * A source error is surfaced to every subscriber after replaying prior items.
 */
export class Broadcast<T> {
  private readonly buffer: T[] = [];
  private done = false;
  private error: unknown;
  private waiters: Array<() => void> = [];
  private readonly listeners = new Set<(item: T) => void>();

  constructor(source: AsyncIterable<T>) {
    void this.pump(source);
  }

  private async pump(source: AsyncIterable<T>): Promise<void> {
    try {
      for await (const item of source) {
        this.buffer.push(item);
        for (const l of this.listeners) l(item);
        this.wake();
      }
    } catch (e) {
      this.error = e;
    } finally {
      this.done = true;
      this.wake();
    }
  }

  private wake(): void {
    const pending = this.waiters;
    this.waiters = [];
    for (const w of pending) w();
  }

  /** Register a live callback for every future item (no replay). Returns unsubscribe. */
  onItem(cb: (item: T) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Replay all buffered items, then follow live until the source completes. */
  async *subscribe(): AsyncIterable<T> {
    let i = 0;
    for (;;) {
      while (i < this.buffer.length) {
        yield this.buffer[i] as T;
        i++;
      }
      if (this.done) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  /** Resolve once the source has fully drained (or rejects with its error). */
  async settled(): Promise<void> {
    for (;;) {
      if (this.done) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** One registered subscriber to an `Emitter` channel. */
type Handler<T> = (payload: T) => void;

/**
 * Minimal typed multi-channel pub/sub. `on` registers a callback and returns an
 * unsubscribe; `stream` exposes the same channel as a backpressure-free async
 * iterable (buffered per-iterator). Fully in-process — no Node `EventEmitter`
 * dependency, so it works identically in every embedding host.
 */
export class Emitter<Events> {
  private readonly handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): Unsubscribe {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => {
      set?.delete(handler as Handler<never>);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // Copy so a handler that unsubscribes mid-dispatch cannot mutate iteration.
    for (const h of [...set]) (h as Handler<Events[K]>)(payload);
  }

  /** Async-iterable view of a channel. Ends when `close()` is called. */
  stream<K extends keyof Events>(event: K, signal?: AbortSignal): AsyncIterable<Events[K]> {
    const queue: Events[K][] = [];
    let resolveNext: (() => void) | undefined;
    let closed = false;

    const push = (payload: Events[K]): void => {
      queue.push(payload);
      resolveNext?.();
      resolveNext = undefined;
    };
    const off = this.on(event, push);
    const stop = (): void => {
      closed = true;
      resolveNext?.();
      resolveNext = undefined;
      off();
    };
    if (signal) {
      if (signal.aborted) stop();
      else signal.addEventListener("abort", stop, { once: true });
    }
    this.closers.add(stop);

    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            while (queue.length > 0) yield queue.shift() as Events[K];
            if (closed) return;
            await new Promise<void>((resolve) => {
              resolveNext = resolve;
            });
          }
        } finally {
          off();
          self.closers.delete(stop);
        }
      },
    };
  }

  private readonly closers = new Set<() => void>();

  /** Close every open `stream(...)` iterator and drop all handlers. */
  close(): void {
    for (const stop of [...this.closers]) stop();
    this.closers.clear();
    this.handlers.clear();
  }
}
