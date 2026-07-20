/**
 * StreamChunk → `UiEvent` projection (design spec §10.2). This is the single
 * canonical projection: both `@nexuscode/cli` (`src/ui.ts`) and
 * `@nexuscode/tui` (`src/bridge/project.ts`) re-export it from here instead of
 * hand-copying the fold, so the two consumer-side copies cannot drift as
 * `StreamChunk` evolves in later waves. `@nexuscode/core` has no dependency on
 * either package, so the dependency arrow still points the right way.
 */

import type { StreamChunk, Usage } from "@nexuscode/shared";
import type { Labeled } from "./bus.js";

/** One normalized UI event, produced from the engine's `StreamChunk` stream. */
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
  | { t: "done"; lane: string; finishReason: string };

/** Discriminant tag of a `UiEvent`. */
export type UiEventType = UiEvent["t"];

function usageCost(u: Partial<Usage>): number {
  return u.costUsd ?? u.reportedCostUsd ?? 0;
}

interface FailoverStep {
  from: string;
  to: string;
  code: string;
  message: string;
}

/** Extract the router's failover trail from a `run-start.raw`, if present. */
function failoverTrailOf(raw: unknown): FailoverStep[] {
  if (typeof raw !== "object" || raw === null) return [];
  const trail = (raw as { failover?: unknown }).failover;
  if (!Array.isArray(trail)) return [];
  const out: FailoverStep[] = [];
  for (const s of trail) {
    if (typeof s !== "object" || s === null) continue;
    const step = s as Record<string, unknown>;
    out.push({
      from: typeof step.from === "string" ? step.from : "",
      to: typeof step.to === "string" ? step.to : "",
      code: typeof step.code === "string" ? step.code : "",
      message: typeof step.message === "string" ? step.message : "",
    });
  }
  return out;
}

/**
 * Project one `StreamChunk` into zero or more `UiEvent`s. `lane` is the
 * per-provider pane key (`"main"` for single runs, else the adapter id).
 */
export function chunkToUiEvents(chunk: StreamChunk, lane: string): UiEvent[] {
  switch (chunk.type) {
    case "run-start": {
      // A live-failover winner carries a `raw.failover` trail (see router.ts).
      // Surface each hand-off as its own event so the UI can show "failed over
      // A → B" before the new session banner.
      const out: UiEvent[] = [];
      const trail = failoverTrailOf(chunk.raw);
      for (const step of trail) {
        out.push({ t: "failover", lane, from: step.from, to: step.to, code: step.code, message: step.message });
      }
      out.push({ t: "session", id: chunk.runId, provider: chunk.adapterId, model: chunk.model, ts: chunk.ts });
      return out;
    }
    case "session-init":
      return [];
    case "text-delta":
      return chunk.channel === "reasoning"
        ? [{ t: "reasoning", lane, delta: chunk.text }]
        : [{ t: "text", lane, delta: chunk.text }];
    case "reasoning-delta":
      return [{ t: "reasoning", lane, delta: chunk.text }];
    case "tool-call-start":
      // The consolidated call carries its name here; arguments arrive as deltas
      // and are finalized on "tool-call-end", which we fold into the same event.
      return [{ t: "tool_call", lane, id: chunk.id, name: chunk.name, args: undefined }];
    case "tool-call-end":
      return [];
    case "tool-result":
      return [{ t: "tool_result", lane, id: chunk.toolCallId, ok: chunk.isError !== true, result: chunk.content }];
    case "file-edit":
      return [{ t: "diff", lane, path: chunk.path, patch: chunk.diff }];
    case "approval-request":
      return [{ t: "approval", lane, id: chunk.approvalId, action: chunk.kind, detail: JSON.stringify(chunk.detail) }];
    case "usage": {
      const ev: UiEvent = {
        t: "usage",
        lane,
        inputTokens: chunk.usage.inputTokens ?? 0,
        outputTokens: chunk.usage.outputTokens ?? 0,
        costUsd: usageCost(chunk.usage),
      };
      if (chunk.usage.cacheReadTokens !== undefined) ev.cacheRead = chunk.usage.cacheReadTokens;
      if (chunk.usage.cacheWriteTokens !== undefined) ev.cacheWrite = chunk.usage.cacheWriteTokens;
      return [ev];
    }
    case "run-end":
      // Usage is projected once, from the dedicated "usage" chunk that every
      // adapter emits immediately before "run-end" — projecting it again here
      // (from `chunk.usage`) would duplicate the UiEvent in ndjson output.
      return [{ t: "done", lane, finishReason: chunk.finishReason }];
    case "error":
      return [{ t: "error", lane, code: chunk.error.code, message: chunk.error.message, retryable: chunk.retryable }];
    // "tool-call-delta" streams argument fragments; nothing to render alone.
    case "tool-call-delta":
      return [];
    default:
      return [];
  }
}

/** Map a lane index to its stable key. Single runs collapse to `"main"`. */
export function laneKey(laneIndex: number, adapterIds: readonly string[], single: boolean): string {
  if (single) return "main";
  return adapterIds[laneIndex] ?? `lane${laneIndex}`;
}

/** Convert a labeled chunk stream position into `UiEvent`s, resolving the lane. */
export function projectLabeled(
  labeled: Labeled<StreamChunk>,
  adapterIds: readonly string[],
  single: boolean,
): UiEvent[] {
  return chunkToUiEvents(labeled.chunk, laneKey(labeled.laneIndex, adapterIds, single));
}
