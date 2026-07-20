/**
 * `CancelScope` — one cancellation semantics over two transport families. A
 * scope is a tree: cancelling a parent cancels all children (a whole compare);
 * cancelling a leaf kills one run. HTTP adapters read `scope.signal`; subprocess
 * adapters register `scope.onCancel` to run SIGINT → grace → SIGTERM.
 */

export type CancelReason = "user" | "timeout" | "race-won" | "budget" | "parent";

export class CancelScope {
  readonly signal: AbortSignal;
  private readonly controller: AbortController;
  private readonly children = new Set<CancelScope>();
  private readonly handlers = new Set<() => void | Promise<void>>();
  private cancelled = false;
  private cancelReason: CancelReason | undefined;

  constructor(private readonly parent?: CancelScope) {
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    if (parent) {
      if (parent.cancelled) {
        // Parent already cancelled → this scope starts cancelled.
        this.controller.abort();
        this.cancelled = true;
        this.cancelReason = "parent";
      } else {
        parent.children.add(this);
      }
    }
  }

  /** Reason this scope was cancelled, if any. */
  get reason(): CancelReason | undefined {
    return this.cancelReason;
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /** Create a child scope; cancelling this scope cancels the child. */
  child(): CancelScope {
    return new CancelScope(this);
  }

  /**
   * Register a cleanup callback (e.g. kill a subprocess). Runs once, on cancel.
   * If the scope is already cancelled it runs immediately.
   */
  onCancel(fn: () => void | Promise<void>): void {
    if (this.cancelled) {
      void fn();
      return;
    }
    this.handlers.add(fn);
  }

  /** Cancel this scope and all descendants. Idempotent. */
  async cancel(reason: CancelReason): Promise<void> {
    if (this.cancelled) return;
    this.cancelled = true;
    this.cancelReason = reason;
    this.parent?.children.delete(this);

    const work: Array<void | Promise<void>> = [];
    for (const child of [...this.children]) work.push(child.cancel("parent"));
    this.children.clear();
    for (const fn of [...this.handlers]) {
      try {
        work.push(fn());
      } catch {
        // A throwing handler must not block the rest.
      }
    }
    this.handlers.clear();
    this.controller.abort();
    await Promise.allSettled(work);
  }
}

/** Convenience: a detached root scope. */
export function rootScope(): CancelScope {
  return new CancelScope();
}
