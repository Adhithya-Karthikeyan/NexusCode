/**
 * `NexusRun` — the facade's handle over one dispatched orchestration (single
 * `ask`, multi-lane `compare`/`race`/`consensus`, staged `chain`, or an agentic
 * `agent` loop). It wraps the engine's raw `OrchestrationHandle` with:
 *
 *  - a replay `Broadcast` so the caller can stream text AND await the settled
 *    result off the SAME run (the engine queue is single-consumer);
 *  - `UiEvent` projection (the one canonical `projectLabeled` fold — never a
 *    hand-copied projection);
 *  - convenience `textStream()` / `result()` derived from that stream.
 *
 * Every chunk also flows into the `Nexus` global emitter so `on("chunk"/"ui")`
 * subscribers observe every run without wiring each one up by hand.
 */

import type {
  CancelReason,
  Labeled,
  OrchestrationHandle,
  OrchestrationOutcome,
  RunResult,
  StreamChunk,
  UiEvent,
} from "@nexuscode/core";
import { projectLabeled } from "@nexuscode/core";
import { Broadcast } from "./emitter.js";

/** How a chunk is projected into UI events (lane keys + single-run flag). */
export interface RunProjection {
  adapterIds: string[];
  single: boolean;
}

/** A sink the run forwards every labeled chunk to (the Nexus global emitter). */
export interface RunSink {
  chunk(labeled: Labeled<StreamChunk>): void;
  ui(event: UiEvent): void;
}

export class NexusRun {
  private readonly broadcast: Broadcast<Labeled<StreamChunk>>;

  constructor(
    private readonly handle: OrchestrationHandle,
    private readonly projection: RunProjection,
    sink?: RunSink,
  ) {
    this.broadcast = new Broadcast(handle.events());
    if (sink) {
      this.broadcast.onItem((labeled) => {
        sink.chunk(labeled);
        for (const ev of projectLabeled(labeled, projection.adapterIds, projection.single)) {
          sink.ui(ev);
        }
      });
    }
  }

  /** The raw labeled engine chunks, replayable from the start of the run. */
  chunks(): AsyncIterable<Labeled<StreamChunk>> {
    return this.broadcast.subscribe();
  }

  /** Normalized `UiEvent`s (session/text/reasoning/tool_call/usage/done/…). */
  async *events(): AsyncIterable<UiEvent> {
    for await (const labeled of this.broadcast.subscribe()) {
      for (const ev of projectLabeled(labeled, this.projection.adapterIds, this.projection.single)) {
        yield ev;
      }
    }
  }

  /** Just the assistant text deltas, in order — the common streaming path. */
  async *textStream(): AsyncIterable<string> {
    for await (const ev of this.events()) {
      if (ev.t === "text") yield ev.delta;
    }
  }

  /** The fully settled orchestration outcome (all lanes, usage, `partial`). */
  outcome(): Promise<OrchestrationOutcome> {
    return this.handle.outcome();
  }

  /** The winning / primary run result (throws only if no lane produced one). */
  async result(): Promise<RunResult> {
    const outcome = await this.handle.outcome();
    const picked = outcome.winner ?? outcome.runs[0];
    if (!picked) {
      throw new Error("nexus: run produced no result");
    }
    return picked;
  }

  /**
   * Await completion and return the primary answer as a single string — the
   * one-liner convenience for callers that do not need streaming.
   */
  async text(): Promise<string> {
    const result = await this.result();
    return result.text;
  }

  /** Cancel every in-flight lane of this run. */
  async cancel(reason: CancelReason = "user"): Promise<void> {
    await this.handle.scope.cancel(reason);
  }

  /** The run's cancellation scope (a child of its turn's scope). */
  get scope(): OrchestrationHandle["scope"] {
    return this.handle.scope;
  }
}
