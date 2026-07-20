/**
 * Agent progress rides the frozen `StreamChunk` union — NOT a parallel channel.
 *
 * Coordinator-level events (a plan was drafted, a step was reflected on, the
 * loop replanned, a subtask was delegated) are emitted as `text-delta` chunks on
 * the `"reasoning"` channel, with a structured {@link AgentMeta} payload attached
 * via the union's `raw` passthrough. Chat consumers render them as reasoning
 * text; richer UIs (CLI/TUI) read `raw.agent` to draw plan trees and progress
 * bars. The canonical `chunkToUiEvents` projection already maps the reasoning
 * channel, so nothing downstream needs to change.
 */

import type { StreamChunk } from "@nexuscode/shared";

/** The phase of the OODA loop a meta chunk reports. */
export type AgentPhase =
  | "step-start"
  | "observe"
  | "plan"
  | "reflect"
  | "replan"
  | "retry"
  | "delegate"
  | "progress"
  | "goal"
  | "stop";

/** Structured agent metadata carried on a chunk's `raw` field. */
export interface AgentMeta {
  agent: {
    phase: AgentPhase;
    role: string;
    step: number;
    /** Phase-specific detail (plan snapshot, reflection, progress percent, …). */
    data?: unknown;
  };
}

/** Narrow an unknown `raw` payload to an {@link AgentMeta}. */
export function isAgentMeta(raw: unknown): raw is AgentMeta {
  if (typeof raw !== "object" || raw === null) return false;
  const a = (raw as { agent?: unknown }).agent;
  return (
    typeof a === "object" &&
    a !== null &&
    typeof (a as { phase?: unknown }).phase === "string" &&
    typeof (a as { role?: unknown }).role === "string"
  );
}

/**
 * Build a coordinator meta chunk: a reasoning-channel `text-delta` stamped with
 * an {@link AgentMeta} `raw` payload. `text` is the human-readable narration;
 * `data` is the structured detail.
 */
export function agentMetaChunk(
  runId: string,
  role: string,
  phase: AgentPhase,
  step: number,
  text: string,
  data?: unknown,
): StreamChunk {
  const meta: AgentMeta = { agent: { phase, role, step, ...(data !== undefined ? { data } : {}) } };
  return { type: "text-delta", runId, text, channel: "reasoning", raw: meta };
}
