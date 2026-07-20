/**
 * Dispatch/router integration for the cost controller. These helpers plug the
 * pre-run gate and post-run spend record into the EXISTING seams — the hook bus
 * (`pre-run` veto / `post-run` observe) and the router candidate list — without
 * importing `@nexuscode/hooks` or `@nexuscode/core` (the payload shapes are
 * mirrored structurally, exactly as `@nexuscode/hooks` itself does for the
 * kernel). Nothing here rewrites the router or the bus.
 */

import type { CostController } from "./enforce.js";
import type { CostPrincipal, EnforceResult } from "./types.js";

/** A route target the enforcer may rewrite on a downgrade. */
export interface RouteTargetLike {
  providerId: string;
  modelId: string;
}

/** Verdict a `pre-run` hook may return (mirrors `@nexuscode/hooks` `HookVerdict`). */
export interface PreRunVerdict {
  block?: boolean;
  reason?: string;
  /** On downgrade: the model the run should be rerouted to. */
  modify?: { model?: string };
}

/** The `pre-run` payload subset the gate reads (mirrors `HookPayloads["pre-run"]`). */
export interface PreRunPayloadLike {
  adapterId: string;
  model: string;
  runId?: string;
}

/** The `post-run` payload subset the recorder reads (mirrors `HookPayloads["post-run"]`). */
export interface PostRunPayloadLike {
  runId: string;
  /** The run's `Usage` (may carry a `costUsd`). */
  usage?: { costUsd?: number } | undefined;
}

/**
 * Split a `"provider/model"` (or bare model) downgrade target into its parts,
 * defaulting the provider to `fallbackProvider` when the target names only a
 * model.
 */
export function parseDowngradeTarget(
  target: string,
  fallbackProvider: string,
): RouteTargetLike {
  const slash = target.indexOf("/");
  if (slash > 0) {
    return { providerId: target.slice(0, slash), modelId: target.slice(slash + 1) };
  }
  return { providerId: fallbackProvider, modelId: target };
}

/**
 * Apply an {@link EnforceResult} to a route target list. On `deny` returns an
 * empty list (the run must not proceed — the caller surfaces the deny). On
 * `downgrade` returns a single-target list pointing at the cheaper model. On
 * `allow`/`warn` the candidates pass through unchanged.
 */
export function applyDecisionToRoute(
  result: EnforceResult,
  candidates: readonly RouteTargetLike[],
): RouteTargetLike[] {
  if (result.decision === "deny") return [];
  if (result.decision === "downgrade" && result.downgradeTo !== undefined) {
    const fallbackProvider = candidates[0]?.providerId ?? "";
    return [parseDowngradeTarget(result.downgradeTo, fallbackProvider)];
  }
  return [...candidates];
}

/**
 * Build a `pre-run` hook handler that enforces the budget. Returns a function
 * with the `@nexuscode/hooks` `HookHandler<"pre-run">` shape: it VETOES on
 * `deny` and, on `downgrade`, returns a `modify.model` so a downstream hook /
 * the dispatch loop reroutes to the cheaper model. `projectFor` maps the run
 * payload to (principal, projectedUsd) — the host owns that estimate.
 */
export function costPreRunHook(
  controller: CostController,
  projectFor: (payload: PreRunPayloadLike) => { principal: CostPrincipal; projectedUsd: number },
  onDecision?: (result: EnforceResult, payload: PreRunPayloadLike) => void,
): (payload: PreRunPayloadLike) => PreRunVerdict | void {
  return (payload: PreRunPayloadLike): PreRunVerdict | void => {
    const { principal, projectedUsd } = projectFor(payload);
    const result = controller.enforce(principal, projectedUsd);
    onDecision?.(result, payload);
    if (result.decision === "deny") {
      return { block: true, reason: result.reason };
    }
    if (result.decision === "downgrade" && result.downgradeTo !== undefined) {
      const model = parseDowngradeTarget(result.downgradeTo, payload.adapterId).modelId;
      return { reason: result.reason, modify: { model } };
    }
    // allow / warn — observe only (warn surfaced via onDecision).
    return undefined;
  };
}

/**
 * Build a `post-run` hook handler that records actual spend from the completed
 * run's usage. Observe-only (the bus ignores a verdict on `post-run`).
 * `principalFor` maps the payload to its cost principal; `costFor` extracts the
 * run cost (defaults to `payload.usage.costUsd`).
 */
export function costPostRunHook(
  controller: CostController,
  principalFor: (payload: PostRunPayloadLike) => CostPrincipal,
  costFor?: (payload: PostRunPayloadLike) => number,
): (payload: PostRunPayloadLike) => void {
  return (payload: PostRunPayloadLike): void => {
    const cost = costFor ? costFor(payload) : (payload.usage?.costUsd ?? 0);
    if (cost > 0) controller.record(principalFor(payload), cost);
  };
}
