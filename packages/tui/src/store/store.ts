/**
 * `EventStore` — a thin imperative wrapper over the pure reducer for the live
 * CLI wiring. It owns the append-only log and the memoized current `ViewState`,
 * and notifies subscribers. This is the *only* place events accumulate; panels
 * still just read the derived `ViewState` (they never see the store).
 *
 * Headless-testable: no ink, no React. The real CLI feeds `append`; Ink reads
 * `getView()` via a `useSyncExternalStore`-style subscription (see
 * `useEventStore`), but tests can also drive `Workspace` with a plain
 * `events` array and skip the store entirely.
 */

import type { UiEvent } from "./events.js";
import { initialViewState, reduceEvent, type ViewState } from "./viewState.js";

export interface EventStore {
  /** Append one or more events; recomputes the view and notifies subscribers. */
  append: (...events: UiEvent[]) => void;
  /** Current derived view (stable identity between appends). */
  getView: () => ViewState;
  /** Full append-only log (for replay / export / debugging). */
  getLog: () => readonly UiEvent[];
  /** Subscribe to view changes; returns an unsubscribe fn. */
  subscribe: (listener: () => void) => () => void;
  /** Reset to the empty projection (new session). */
  reset: () => void;
}

export function createEventStore(seed: readonly UiEvent[] = []): EventStore {
  const log: UiEvent[] = [];
  let view: ViewState = initialViewState;
  const listeners = new Set<() => void>();

  const emit = (): void => {
    for (const l of listeners) l();
  };

  const append = (...events: UiEvent[]): void => {
    if (events.length === 0) return;
    // One ingest timestamp per append call (not per event, and never read
    // inside the reducer) — see `reduceEvent`'s purity contract.
    const ts = Date.now();
    for (const ev of events) {
      log.push(ev);
      view = reduceEvent(view, ev, ts);
    }
    emit();
  };

  if (seed.length > 0) append(...seed);

  return {
    append,
    getView: () => view,
    getLog: () => log,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset: () => {
      log.length = 0;
      view = initialViewState;
      emit();
    },
  };
}
