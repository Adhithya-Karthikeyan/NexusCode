/**
 * Session replay. The event_log stores every `StreamChunk` verbatim (as JSON) in
 * bus `seq` order, so a session can be re-materialized into the exact `UiEvent`
 * timeline it produced live — we reuse `@nexuscode/core`'s canonical
 * `chunkToUiEvents` projection rather than re-deriving the fold, so a replay can
 * never drift from what the TUI/CLI rendered the first time.
 */

import { chunkToUiEvents, type UiEvent } from "@nexuscode/core";
import type { StreamChunk } from "@nexuscode/shared";
import type { EventRow } from "./types.js";

/** Parse one persisted event row's JSON payload back into a `StreamChunk`. */
export function rowToChunk(row: EventRow): StreamChunk | null {
  try {
    return JSON.parse(row.payload) as StreamChunk;
  } catch {
    return null;
  }
}

/**
 * Re-materialize a persisted event stream into the `UiEvent` timeline. Rows must
 * already be in `seq` order (as returned by the store). `lane` defaults to
 * `"main"`, matching a single-provider run's pane key in the live projection.
 */
export function replayEvents(rows: readonly EventRow[], lane = "main"): UiEvent[] {
  const out: UiEvent[] = [];
  for (const row of rows) {
    const chunk = rowToChunk(row);
    if (!chunk) continue;
    for (const ev of chunkToUiEvents(chunk, lane)) out.push(ev);
  }
  return out;
}
