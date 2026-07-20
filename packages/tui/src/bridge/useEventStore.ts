/**
 * `useEventStore` — subscribe an Ink tree to a live `EventStore` (design spec
 * §10.2). The store is the *only* place events accumulate; this hook wires its
 * `subscribe`/`getView` into React via `useSyncExternalStore` so the pure-renderer
 * tree re-renders on every append with a stable `ViewState` identity between them.
 */

import { useSyncExternalStore } from "react";
import type { EventStore } from "../store/store.js";
import type { ViewState } from "../store/viewState.js";

/** Current derived `ViewState`, re-read whenever the store notifies. */
export function useEventStore(store: EventStore): ViewState {
  return useSyncExternalStore(store.subscribe, store.getView, store.getView);
}
