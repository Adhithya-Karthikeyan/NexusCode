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
  | {
      t: "session";
      /** The RUN id (`chunk.runId`) — kept as-is for backward compatibility. */
      id: string;
      /**
       * The engine SESSION id, when the caller has one to give. `StreamChunk`
       * is a frozen, provider-agnostic contract (see `@nexuscode/shared`'s
       * events.ts) that only ever carries a run id — a session spans many
       * runs (one per turn), so the projection can't recover it from the
       * chunk alone. Callers that hold a `Session` (from `engine.openSession`)
       * pass its id into `chunkToUiEvents`/`projectLabeled`; callers that
       * don't (e.g. a bare replay of a chunk log) simply omit it. This is what
       * a client must pass to `--resume`/`OpenSessionOptions.resume` — `id`
       * above is a run id and resuming with it silently starts a new session.
       */
      sessionId?: string;
      provider: string;
      model: string;
      ts: number;
    }
  | {
      t: "route";
      chosen: string;
      reason: "explicit" | "cost" | "latency" | "capability" | "local";
      candidates: string[];
    }
  | { t: "failover"; lane: string; from: string; to: string; code: string; message: string }
  | { t: "text"; lane: string; delta: string }
  | { t: "reasoning"; lane: string; delta: string }
  | {
      t: "agent";
      lane: string;
      /**
       * The OODA-loop phase (`packages/agent/src/events.ts`'s `AgentPhase`).
       * Typed as `string`, not the closed `AgentPhase` union — this package
       * cannot import that type (`@nexuscode/agent` depends on
       * `@nexuscode/core`, not the reverse), and a hand-copied closed union
       * here would silently drop a phase a newer agent package adds.
       */
      phase: string;
      role: string;
      step: number;
      /**
       * The same human-readable narration the paired `reasoning` event
       * carries (`chunk.text`), duplicated here rather than left implicit so
       * a consumer reading per-step narration doesn't have to assume "the
       * next event after an `agent` event is its narration" — that couples a
       * pure `(state, event) -> state` reducer to wire adjacency, which
       * breaks the first time a reasoning delta interleaves.
       */
      text: string;
      data?: unknown;
    }
  | { t: "tool_call"; lane: string; id: string; name: string; args: unknown }
  | { t: "tool_result"; lane: string; id: string; ok: boolean; result: unknown }
  | { t: "diff"; lane: string; path: string; patch: string }
  | {
      t: "approval";
      lane: string;
      id: string;
      action: string;
      detail: string;
      /**
       * Present only on a SECOND `approval` event carrying the same `id` as an
       * earlier request — the settlement of that approval. Absent on the
       * original request (still pending) and on the wrapped-coding-CLI's
       * `approval-request` flow (`chunkToUiEvents`'s `"approval-request"` case
       * below), which never resolves this way. `cause` is a closed set so a
       * client can tell an explicit "no" (final) apart from the harness
       * deciding FOR the human (timeout: not a decision, offer to ask again;
       * cancelled/stdin-closed: the conversation is gone, the approval is
       * moot) without parsing the human-readable `reason` prose the CLI
       * ALSO still records (unchanged) in the corresponding `tool_result`.
       */
      resolution?: { granted: boolean; cause: "explicit" | "timeout" | "cancelled" | "stdin-closed" };
    }
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

/** Structural shape of the coordinator metadata `packages/agent/src/events.ts`'s
 * `agentMetaChunk()` stamps onto a reasoning-channel `text-delta`'s `raw`. */
interface AgentMetaRaw {
  agent: {
    phase: string;
    role: string;
    step: number;
    data?: unknown;
  };
}

/**
 * Narrow an unknown `raw` payload to {@link AgentMetaRaw}. Mirrors
 * `isAgentMeta` in `packages/agent/src/events.ts` structurally (same pattern
 * as `failoverTrailOf` above for `raw.failover`) — duplicated rather than
 * imported because `@nexuscode/core` must not depend on `@nexuscode/agent`
 * (the dependency arrow points the other way).
 */
function isAgentMetaRaw(raw: unknown): raw is AgentMetaRaw {
  if (typeof raw !== "object" || raw === null) return false;
  const a = (raw as { agent?: unknown }).agent;
  if (typeof a !== "object" || a === null) return false;
  const rec = a as Record<string, unknown>;
  return typeof rec.phase === "string" && typeof rec.role === "string" && typeof rec.step === "number";
}

/**
 * Project one `StreamChunk` into zero or more `UiEvent`s. `lane` is the
 * per-provider pane key (`"main"` for single runs, else the adapter id).
 *
 * `sessionId` is optional and purely additive: pass the engine `Session.id`
 * when the caller has one open (see the `session` `UiEvent`'s doc comment for
 * why the chunk stream itself can never carry it).
 */
export function chunkToUiEvents(chunk: StreamChunk, lane: string, sessionId?: string): UiEvent[] {
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
      const sessionEvent: UiEvent = {
        t: "session",
        id: chunk.runId,
        provider: chunk.adapterId,
        model: chunk.model,
        ts: chunk.ts,
      };
      if (sessionId !== undefined) sessionEvent.sessionId = sessionId;
      out.push(sessionEvent);
      return out;
    }
    case "session-init":
      // Agent loops suppress duplicate provider run-start chunks on later
      // turns. A synthetic session-init carries only the failover trail so the
      // switch receipt remains visible without violating the stream contract.
      return failoverTrailOf(chunk.raw).map((step) => ({
        t: "failover",
        lane,
        from: step.from,
        to: step.to,
        code: step.code,
        message: step.message,
      }));
    case "text-delta": {
      if (chunk.channel !== "reasoning") return [{ t: "text", lane, delta: chunk.text }];
      // A coordinator progress chunk (see `packages/agent/src/events.ts`'s
      // `agentMetaChunk()`) stamps `raw` with phase/role/step metadata. Surface
      // it as a leading `agent` event — the header for the narration that
      // follows — while leaving the plain `reasoning` event unchanged so every
      // existing text-only consumer keeps working byte-identically.
      const out: UiEvent[] = [];
      if (isAgentMetaRaw(chunk.raw)) {
        const { phase, role, step, data } = chunk.raw.agent;
        const agentEvent: UiEvent = { t: "agent", lane, phase, role, step, text: chunk.text };
        if (data !== undefined) agentEvent.data = data;
        out.push(agentEvent);
      }
      out.push({ t: "reasoning", lane, delta: chunk.text });
      return out;
    }
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
  sessionId?: string,
): UiEvent[] {
  return chunkToUiEvents(labeled.chunk, laneKey(labeled.laneIndex, adapterIds, single), sessionId);
}
