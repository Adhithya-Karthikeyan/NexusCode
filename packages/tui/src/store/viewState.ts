/**
 * The immutable event-log reducer (design spec §10.2, §10.4-1).
 *
 * `ViewState` is the *derived* projection of the append-only `UiEvent[]` log —
 * the only thing panels read. No panel owns state; every view is a selector over
 * this one structure. `reduceEvent` is a pure `(state, event, ts) → state` fold
 * that returns a fresh, structurally-shared value (never mutates its input, and
 * never reads the wall clock itself), so the whole tree can memoize on identity
 * and a resize/replay never loses data *or* re-stamps it to a new "now".
 */

import type { UiEvent } from "./events.js";

/** Health of one provider, derived passively from real request outcomes (§2.5). */
export type ProviderStatus = "ok" | "warm" | "degraded" | "down";

export interface ProviderHealth {
  provider: string;
  status: ProviderStatus;
  /** ms timestamp of the last outcome that set this status (staleness cue). */
  lastTs: number;
  /** Human word shown next to the dot; never color-only. */
  note: string;
}

/** A single in-flight or finalized tool invocation on a lane. */
export interface ToolActivity {
  id: string;
  lane: string;
  name: string;
  args: unknown;
  status: "running" | "ok" | "error";
  result?: unknown;
}

/** A file edit surfaced during a turn (preview; apply is engine-owned). */
export interface TurnDiff {
  path: string;
  patch: string;
}

/** One assistant-side turn on a lane: text + reasoning + tools, delimited by `done`. */
export interface Turn {
  id: string;
  lane: string;
  /**
   * The user prompt that started this turn, when the client injected a `prompt`
   * marker (§10.4-1). Stamped on the turn at creation so the prompt↔turn pairing
   * is intrinsic — it survives interruption, replay and `<Static>` commit without
   * positional drift. `undefined` for turns started by a bare assistant event
   * (the legacy positional-echo path still supplies the prompt at render time).
   */
  prompt?: string;
  text: string;
  reasoning: string;
  tools: ToolActivity[];
  diffs: TurnDiff[];
  finished: boolean;
  finishReason?: string;
  startedTs: number;
}

/** Per-lane conversation state: the live (streaming) turn + finalized history. */
export interface LaneState {
  lane: string;
  live: Turn | null;
  finalized: Turn[];
}

/** A notification/receipt derived from `error` / `approval` events. */
export interface NotificationItem {
  kind: "error" | "approval";
  lane: string;
  ts: number;
  title: string;
  detail: string;
  retryable?: boolean;
}

/** Session identity (from the `session` event). */
export interface SessionInfo {
  id: string;
  provider: string;
  model: string;
  ts: number;
}

/** Routing decision (from the `route` event). */
export interface RouteInfo {
  chosen: string;
  reason: "explicit" | "cost" | "latency" | "capability" | "local";
  candidates: string[];
}

/** Cumulative + last-request token/cost totals. */
export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

/** The full derived view — the single input to every selector. */
export interface ViewState {
  session: SessionInfo | null;
  route: RouteInfo | null;
  lanes: Readonly<Record<string, LaneState>>;
  laneOrder: readonly string[];
  totals: UsageTotals;
  /** Cost attributed to the most recent `usage` event (the "run"). */
  runUsd: number;
  /** Tokens of the most recent request (context sizing for the HUD gauge). */
  lastUsage: { inputTokens: number; outputTokens: number };
  providerHealth: Readonly<Record<string, ProviderHealth>>;
  notifications: readonly NotificationItem[];
  streaming: boolean;
  eventCount: number;
}

/** The empty projection — the render target before any event arrives. */
export const initialViewState: ViewState = Object.freeze({
  session: null,
  route: null,
  lanes: {},
  laneOrder: [],
  totals: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
  runUsd: 0,
  lastUsage: { inputTokens: 0, outputTokens: 0 },
  providerHealth: {},
  notifications: [],
  streaming: false,
  eventCount: 0,
});

/**
 * A turn's id is derived from `(lane, finalized-count)` — deterministic given the
 * log, so replaying a prefix yields byte-identical ids (time-travel / fork safe,
 * §10.2). No global counter.
 */
function newTurn(lane: string, ts: number, index: number): Turn {
  return {
    id: `turn-${lane}-${index}`,
    lane,
    text: "",
    reasoning: "",
    tools: [],
    diffs: [],
    finished: false,
    startedTs: ts,
  };
}

function ensureLane(state: ViewState, lane: string): { lanes: Record<string, LaneState>; laneOrder: string[] } {
  const lanes = { ...state.lanes };
  const laneOrder = state.laneOrder.slice();
  if (!lanes[lane]) {
    lanes[lane] = { lane, live: null, finalized: [] };
    laneOrder.push(lane);
  }
  return { lanes, laneOrder };
}

/** Get (or start) the live turn for a lane, returning a fresh lane map. */
function withLiveTurn(
  state: ViewState,
  lane: string,
  ts: number,
  mutate: (turn: Turn) => Turn,
): ViewState {
  const { lanes, laneOrder } = ensureLane(state, lane);
  const current = lanes[lane]!;
  const live = current.live ?? newTurn(lane, ts, current.finalized.length);
  const next = mutate({ ...live, tools: live.tools.slice(), diffs: live.diffs.slice() });
  lanes[lane] = { ...current, live: next };
  return recomputeStreaming({ ...state, lanes, laneOrder, eventCount: state.eventCount + 1 });
}

function recomputeStreaming(state: ViewState): ViewState {
  const streaming = Object.values(state.lanes).some((l) => l.live !== null);
  return state.streaming === streaming ? state : { ...state, streaming };
}

/**
 * The provider key a lane's health should be attributed to. In fan-out
 * (compare/race) the lane key IS the adapter id (§10.2's `laneKey` invariant —
 * `session` is emitted per run-start and gets overwritten by the last one, so
 * it can't disambiguate lanes); only the single-run `"main"` lane falls back to
 * the session's provider.
 */
function providerFor(state: ViewState, lane: string): string {
  return lane === "main" ? (state.session?.provider ?? lane) : lane;
}

/** Whether a lane currently has a live (in-flight) turn. */
function hasLiveTurn(state: ViewState, lane: string): boolean {
  return state.lanes[lane]?.live != null;
}

/**
 * Commit a lane's live turn to its finalized history, stamping a finish reason.
 * The single delimiter used by `done` (natural end), by `error` (a turn that
 * failed) and by the next `prompt` marker (an interrupted turn with no `done`) —
 * so a dangling live turn can never silently merge into the next prompt's turn.
 * A no-op (returns `state` unchanged) when the lane has no live turn. Does not
 * touch health / `eventCount` / `streaming`; the caller composes those.
 */
function finalizeLive(state: ViewState, lane: string, finishReason: string): ViewState {
  if (!hasLiveTurn(state, lane)) return state;
  const { lanes, laneOrder } = ensureLane(state, lane);
  const current = lanes[lane]!;
  const live = current.live!;
  const finalizedTurn: Turn = { ...live, finished: true, finishReason };
  lanes[lane] = { ...current, live: null, finalized: [...current.finalized, finalizedTurn] };
  return { ...state, lanes, laneOrder };
}

function setHealth(
  state: ViewState,
  provider: string,
  status: ProviderStatus,
  note: string,
  ts: number,
): Readonly<Record<string, ProviderHealth>> {
  return { ...state.providerHealth, [provider]: { provider, status, note, lastTs: ts } };
}

/**
 * Fold one event into the view. Pure: returns a new `ViewState`, never mutates
 * `state`, and never reads the wall clock — `ts` is the *ingest* timestamp the
 * caller stamps the event with (once, at append time for a live store; a
 * stable derived clock for replay), so folding the same `(state, ev, ts)` twice
 * always yields byte-identical output. Unknown/lane-less events still bump
 * `eventCount` so the log length is observable.
 */
export function reduceEvent(state: ViewState, ev: UiEvent, ts: number): ViewState {
  switch (ev.t) {
    case "session":
      return {
        ...state,
        session: { id: ev.id, provider: ev.provider, model: ev.model, ts: ev.ts },
        providerHealth: setHealth(state, ev.provider, "ok", "ok", ev.ts),
        eventCount: state.eventCount + 1,
      };

    case "route":
      return {
        ...state,
        route: { chosen: ev.chosen, reason: ev.reason, candidates: ev.candidates.slice() },
        eventCount: state.eventCount + 1,
      };

    case "prompt": {
      // A client-injected turn delimiter. Finalize any dangling live turn (one
      // interrupted / errored with no `done`) FIRST so this prompt starts a
      // fresh turn instead of merging into the previous one, then open a new
      // live turn stamped with the user's prompt text (intrinsic pairing).
      const base = finalizeLive(state, ev.lane, "interrupted");
      const { lanes, laneOrder } = ensureLane(base, ev.lane);
      const current = lanes[ev.lane]!;
      const turn: Turn = { ...newTurn(ev.lane, ts, current.finalized.length), prompt: ev.text };
      lanes[ev.lane] = { ...current, live: turn };
      return recomputeStreaming({ ...base, lanes, laneOrder, eventCount: base.eventCount + 1 });
    }

    case "text":
      return withLiveTurn(state, ev.lane, ts, (t) => ({ ...t, text: t.text + ev.delta }));

    case "reasoning":
      return withLiveTurn(state, ev.lane, ts, (t) => ({
        ...t,
        reasoning: t.reasoning + ev.delta,
      }));

    case "tool_call":
      return withLiveTurn(state, ev.lane, ts, (t) => ({
        ...t,
        tools: [...t.tools, { id: ev.id, lane: ev.lane, name: ev.name, args: ev.args, status: "running" }],
      }));

    case "tool_result": {
      // A stray/late result with no live turn can't belong to anything in
      // view; ignore it rather than minting a blank turn (§10.4-7 no false
      // streaming flips from terminal events that arrive out of band).
      if (!hasLiveTurn(state, ev.lane)) return { ...state, eventCount: state.eventCount + 1 };
      return withLiveTurn(state, ev.lane, ts, (t) => ({
        ...t,
        tools: t.tools.map((tool) =>
          tool.id === ev.id
            ? { ...tool, status: ev.ok ? "ok" : "error", result: ev.result }
            : tool,
        ),
      }));
    }

    case "diff":
      return withLiveTurn(state, ev.lane, ts, (t) => ({
        ...t,
        diffs: [...t.diffs, { path: ev.path, patch: ev.patch }],
      }));

    case "approval": {
      const item: NotificationItem = {
        kind: "approval",
        lane: ev.lane,
        ts,
        title: `approval: ${ev.action}`,
        detail: ev.detail,
      };
      return {
        ...state,
        notifications: [...state.notifications, item],
        eventCount: state.eventCount + 1,
      };
    }

    case "usage": {
      const totals: UsageTotals = {
        inputTokens: state.totals.inputTokens + ev.inputTokens,
        outputTokens: state.totals.outputTokens + ev.outputTokens,
        cacheRead: state.totals.cacheRead + (ev.cacheRead ?? 0),
        cacheWrite: state.totals.cacheWrite + (ev.cacheWrite ?? 0),
        costUsd: state.totals.costUsd + ev.costUsd,
      };
      return {
        ...state,
        totals,
        runUsd: ev.costUsd,
        lastUsage: { inputTokens: ev.inputTokens, outputTokens: ev.outputTokens },
        providerHealth: setHealth(state, providerFor(state, ev.lane), "ok", "ok", ts),
        eventCount: state.eventCount + 1,
      };
    }

    case "failover": {
      // A live provider hand-off (router.ts). Surface it as a recoverable
      // notification and mark the departed provider degraded, the new one ok —
      // exactly the "failed over A → B" affordance the differentiator promises.
      const item: NotificationItem = {
        kind: "error",
        lane: ev.lane,
        ts,
        title: `failover: ${ev.from} → ${ev.to}`,
        detail: `${ev.code}: ${ev.message}`,
        retryable: true,
      };
      const withFrom = { ...state, providerHealth: setHealth(state, ev.from, "degraded", "degraded", ts) };
      return {
        ...state,
        notifications: [...state.notifications, item],
        providerHealth: setHealth(withFrom, ev.to, "ok", "ok", ts),
        eventCount: state.eventCount + 1,
      };
    }

    case "error": {
      const item: NotificationItem = {
        kind: "error",
        lane: ev.lane,
        ts,
        title: `error: ${ev.code}`,
        detail: ev.message,
        retryable: ev.retryable,
      };
      const status: ProviderStatus = ev.retryable ? "degraded" : "down";
      // Finalize the failed turn (if one is live) so it commits to scrollback as
      // an interrupted turn and the next prompt never merges into it. A no-op
      // when the error arrived before any streaming (nothing to clear).
      const cleared = finalizeLive(state, ev.lane, `error:${ev.code}`);
      return recomputeStreaming({
        ...cleared,
        notifications: [...cleared.notifications, item],
        providerHealth: setHealth(cleared, providerFor(cleared, ev.lane), status, status, ts),
        eventCount: cleared.eventCount + 1,
      });
    }

    case "done": {
      // A stray/late "done" with no live turn (e.g. a duplicate or a
      // post-cancel terminal event) would otherwise mint a blank turn — a
      // false scrollback bubble and a brief false streaming flip. Ignore it.
      if (!hasLiveTurn(state, ev.lane)) return { ...state, eventCount: state.eventCount + 1 };
      const finalized = finalizeLive(state, ev.lane, ev.finishReason);
      return recomputeStreaming({
        ...finalized,
        providerHealth: setHealth(finalized, providerFor(finalized, ev.lane), "ok", "ok", ts),
        eventCount: finalized.eventCount + 1,
      });
    }

    default:
      return { ...state, eventCount: state.eventCount + 1 };
  }
}

/**
 * Fold a whole event log into a view (used for replay / initial derivation).
 * Deterministic: the ingest `ts` for each event is derived from its position
 * in the log (a stable, monotonic clock), never the wall clock — so folding
 * the same log twice always yields byte-identical state (§10.4-1, no replay
 * timestamp drift). A live store instead stamps a real `Date.now()` once per
 * `append` (see `EventStore`), which is genuinely "now" for a live append.
 */
export function reduceEvents(events: readonly UiEvent[], base: ViewState = initialViewState): ViewState {
  let state = base;
  for (let i = 0; i < events.length; i++) {
    state = reduceEvent(state, events[i]!, i);
  }
  return state;
}
