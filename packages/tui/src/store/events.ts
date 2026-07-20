/**
 * `UiEvent` — the TUI's copy of the engine's normalized event union, kept
 * **structurally identical** to `packages/cli/src/ui.ts` (design spec §10.2).
 *
 * The TUI is a *pure renderer* over this stream: the engine (`@nexuscode/core`)
 * is the single source of truth and emits an append-only `UiEvent[]` log; every
 * panel is a selector over it (§10.4 invariant 1). We re-declare the union here
 * rather than importing from `@nexuscode/cli` so the renderer never takes a
 * dependency on the CLI (the dependency arrow points the other way). A structural
 * drift is caught by the shared `StreamChunk` contract both projections target.
 */

/** One normalized UI event. Mirror of the CLI `UiEvent` union. */
export type UiEvent =
  | { t: "session"; id: string; provider: string; model: string; ts: number }
  | {
      t: "route";
      chosen: string;
      reason: "explicit" | "cost" | "latency" | "capability" | "local";
      candidates: string[];
    }
  | { t: "failover"; lane: string; from: string; to: string; code: string; message: string }
  | { t: "text"; lane: string; delta: string }
  | { t: "reasoning"; lane: string; delta: string }
  | { t: "tool_call"; lane: string; id: string; name: string; args: unknown }
  | { t: "tool_result"; lane: string; id: string; ok: boolean; result: unknown }
  | { t: "diff"; lane: string; path: string; patch: string }
  | { t: "approval"; lane: string; id: string; action: string; detail: string }
  | {
      t: "usage";
      lane: string;
      inputTokens: number;
      outputTokens: number;
      cacheRead?: number;
      cacheWrite?: number;
      costUsd: number;
    }
  | { t: "error"; lane: string; code: string; message: string; retryable: boolean }
  | { t: "done"; lane: string; finishReason: string }
  // The single CLIENT-originated marker (the engine NEVER emits this). The TUI
  // injects it into the same append-only log at submit time so the user prompt
  // interleaves with the assistant stream and `reduceEvent` owns the prompt↔turn
  // pairing — no positional drift when a turn is interrupted, errors before
  // streaming, or a prompt starts no turn (§10.4-1 stays additive: this variant
  // is a superset of the engine mirror, tagged distinctly so it can never be
  // confused with a real engine event).
  | { t: "prompt"; lane: string; id: string; text: string };

/** Discriminant tag of a `UiEvent`. */
export type UiEventType = UiEvent["t"];

/** The stable lane key for a single (non-fanned-out) run, per the CLI projection. */
export const MAIN_LANE = "main" as const;

/** Narrow a `UiEvent` to a specific variant (handy in selectors/tests). */
export function isEvent<T extends UiEventType>(
  ev: UiEvent,
  t: T,
): ev is Extract<UiEvent, { t: T }> {
  return ev.t === t;
}

/** The `lane` a given event belongs to, or `undefined` for lane-less events. */
export function eventLane(ev: UiEvent): string | undefined {
  return "lane" in ev ? ev.lane : undefined;
}
