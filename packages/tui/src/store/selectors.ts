/**
 * Selectors over `ViewState` (design spec §2.2 "each panel is a pure selector").
 * Components import these; they never touch the reducer or hold state.
 */

import { MAIN_LANE } from "./events.js";
import type {
  LaneState,
  NotificationItem,
  ProviderHealth,
  ToolActivity,
  Turn,
  ViewState,
} from "./viewState.js";

/** Session identity for the header/HUD, or `null` before the run starts. */
export function selectSession(v: ViewState): ViewState["session"] {
  return v.session;
}

/** The served model + provider (anti-substitution display, §2.3). */
export function selectModel(v: ViewState): { model: string; provider: string } {
  if (v.session) return { model: v.session.model, provider: v.session.provider };
  if (v.route) return { model: v.route.chosen, provider: v.route.chosen };
  return { model: "—", provider: "—" };
}

/** Session + run cost for `<CostMeter>` (§3.7). */
export function selectCost(v: ViewState): { sessionUsd: number; runUsd: number } {
  return { sessionUsd: v.totals.costUsd, runUsd: v.runUsd };
}

/**
 * Context gauge inputs (§2.5). `used` is the size of the most recent request
 * (input + output tokens); `max` is the real window, supplied by the caller
 * (the engine owns the true number; the TUI never invents it).
 */
export function selectContext(v: ViewState, max: number): { used: number; max: number; pct: number } {
  const used = v.lastUsage.inputTokens + v.lastUsage.outputTokens;
  const pct = max > 0 ? Math.min(1, used / max) : 0;
  return { used, max, pct };
}

/** Whether any lane is currently streaming (drives the `⟳` glyph + spinners). */
export function selectStreaming(v: ViewState): boolean {
  return v.streaming;
}

/** Provider health dots, in first-seen order. */
export function selectProviderHealth(v: ViewState): ProviderHealth[] {
  return Object.values(v.providerHealth);
}

/** The active provider (from session) if its health is known. */
export function selectActiveHealth(v: ViewState): ProviderHealth | null {
  const p = v.session?.provider;
  return p ? v.providerHealth[p] ?? null : null;
}

/** Whether a failover has been observed (any non-active provider is unhealthy). */
export function selectFailover(v: ViewState): boolean {
  const active = v.session?.provider;
  return Object.values(v.providerHealth).some(
    (h) => h.provider !== active && (h.status === "degraded" || h.status === "down"),
  );
}

/** One lane's state (`"main"` for single runs). */
export function selectLane(v: ViewState, lane: string = MAIN_LANE): LaneState | null {
  return v.lanes[lane] ?? null;
}

/** All lane keys in event order (compare/race columns). */
export function selectLaneOrder(v: ViewState): readonly string[] {
  return v.laneOrder;
}

/** Finalized turns for a lane — the `<Static>` scrollback content (Mode A). */
export function selectFinalizedTurns(v: ViewState, lane: string = MAIN_LANE): readonly Turn[] {
  return v.lanes[lane]?.finalized ?? [];
}

/** The in-flight turn for a lane — the pinned live region (Mode A). */
export function selectLiveTurn(v: ViewState, lane: string = MAIN_LANE): Turn | null {
  return v.lanes[lane]?.live ?? null;
}

/** All finalized turns across every lane, flattened for a single conversation view. */
export function selectAllFinalizedTurns(v: ViewState): Turn[] {
  return v.laneOrder.flatMap((lane) => v.lanes[lane]?.finalized ?? []);
}

/** Flattened tool activity (live + finalized) for the Tool Activity panel. */
export function selectToolActivity(v: ViewState): ToolActivity[] {
  const out: ToolActivity[] = [];
  for (const lane of v.laneOrder) {
    const l = v.lanes[lane];
    if (!l) continue;
    for (const t of l.finalized) out.push(...t.tools);
    if (l.live) out.push(...l.live.tools);
  }
  return out;
}

/** Running tool count (for rail summaries / HUD). */
export function selectRunningToolCount(v: ViewState): number {
  return selectToolActivity(v).filter((t) => t.status === "running").length;
}

/** Notifications (errors + approvals), newest last. */
export function selectNotifications(v: ViewState): readonly NotificationItem[] {
  return v.notifications;
}

/** Count of error notifications (rail summary). */
export function selectErrorCount(v: ViewState): number {
  return v.notifications.filter((n) => n.kind === "error").length;
}

/** Total finalized message count across lanes (rail summary). */
export function selectMessageCount(v: ViewState): number {
  return v.laneOrder.reduce((n, lane) => n + (v.lanes[lane]?.finalized.length ?? 0), 0);
}
