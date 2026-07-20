/**
 * ChangeBatcher — debounced file-change coalescing (system-spec §23: incremental
 * updates · watch mode).
 *
 * A filesystem watcher fires a burst of raw events for a single logical edit
 * (write + rename + chmod, editors that save via temp-file swap, a `git checkout`
 * touching hundreds of paths). Re-indexing on every raw event would thrash. This
 * batcher accumulates the distinct changed paths and, after a quiet `delayMs`
 * window with no further notifications, flushes the whole set once to `onFlush`.
 *
 * The timer is injectable so a test can drive it deterministically (fake timers,
 * or a manual {@link flush}) without real sleeps. Pure logic — it does no I/O and
 * knows nothing about `fs.watch`; the watcher merely calls {@link notify}.
 */

/** A minimal timer seam so tests can substitute deterministic timers. */
export interface BatcherTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimer: BatcherTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface ChangeBatcherOptions {
  /** Called once per quiet window with the distinct changed paths (in insertion order). */
  onFlush: (paths: string[]) => void | Promise<void>;
  /** Quiet-window length in ms before a flush fires (default 150). */
  delayMs?: number;
  /** Injectable timer (tests). Defaults to `setTimeout`/`clearTimeout`. */
  timer?: BatcherTimer;
}

export class ChangeBatcher {
  private readonly onFlush: (paths: string[]) => void | Promise<void>;
  private readonly delayMs: number;
  private readonly timer: BatcherTimer;
  private readonly changed = new Set<string>();
  private handle: unknown;
  private closed = false;
  /** Resolves after the most recently scheduled flush completes (for tests). */
  private lastFlush: Promise<void> = Promise.resolve();

  constructor(opts: ChangeBatcherOptions) {
    this.onFlush = opts.onFlush;
    this.delayMs = opts.delayMs && opts.delayMs > 0 ? opts.delayMs : 150;
    this.timer = opts.timer ?? defaultTimer;
  }

  /** Record a changed path and (re)arm the debounce window. No-op after {@link close}. */
  notify(path: string): void {
    if (this.closed) return;
    this.changed.add(path);
    if (this.handle !== undefined) this.timer.clear(this.handle);
    this.handle = this.timer.set(() => {
      this.handle = undefined;
      this.lastFlush = this.drain();
    }, this.delayMs);
  }

  /** The paths accumulated since the last flush (defensive copy). */
  get pending(): string[] {
    return [...this.changed];
  }

  /**
   * Flush immediately (cancelling any pending timer) and await `onFlush`. A no-op
   * when nothing is pending. Returns the flush promise so callers/tests can await
   * the reindex.
   */
  async flush(): Promise<void> {
    if (this.handle !== undefined) {
      this.timer.clear(this.handle);
      this.handle = undefined;
    }
    this.lastFlush = this.drain();
    return this.lastFlush;
  }

  /** Await whatever flush the debounce timer most recently kicked off (tests). */
  async settled(): Promise<void> {
    return this.lastFlush;
  }

  /** Cancel any pending flush and stop accepting notifications. */
  close(): void {
    this.closed = true;
    if (this.handle !== undefined) {
      this.timer.clear(this.handle);
      this.handle = undefined;
    }
    this.changed.clear();
  }

  private async drain(): Promise<void> {
    if (this.changed.size === 0) return;
    const paths = [...this.changed];
    this.changed.clear();
    await this.onFlush(paths);
  }
}
