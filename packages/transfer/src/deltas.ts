/**
 * Typed deltas + DeltaBus.
 *
 * A `Delta` is the discriminated union that flows from the runner (via the
 * EventProjector) into the DeltaSyncBus, which appends each to the WAL and
 * folds it into the materialized store. `DeltaBus` is a thin in-memory emitter
 * the runner uses to fan deltas out; for Phase 1 it just buffers and broadcasts.
 */

import type { EpisodicFields, GraphEdge, GraphNode, KnowledgeItem } from "./items.js";

export type Delta =
  | { op: "upsert-item"; item: KnowledgeItem }
  | { op: "supersede-item"; id: string; byId: string; sessionId: string }
  | { op: "put-node"; node: GraphNode; sessionId: string }
  | { op: "put-edge"; edge: GraphEdge; sessionId: string }
  | {
      op: "execution-event";
      sessionId: string;
      subId?: string;
      lamportTs: number;
      actionId: string;
      entityId: string;
      fields: EpisodicFields;
      title: string;
      body: string;
    }
  | { op: "capture"; sessionId: string; subId?: string; lamportTs: number; payload: Uint8Array | string }
  | {
      op: "handoff";
      sessionId: string;
      subId?: string;
      lamportTs: number;
      fromProvider: string;
      toProvider: string;
      reason: string;
    };

/** Delta handler. */
export type DeltaHandler = (delta: Delta) => void;

/** A minimal in-memory delta emitter (buffered fan-out). */
export interface DeltaBus {
  on(handler: DeltaHandler): () => void;
  emit(delta: Delta): void;
  /** All deltas emitted since the bus was created (Phase 1 buffer). */
  buffered(): Delta[];
}

/** Create a DeltaBus. */
export function createDeltaBus(): DeltaBus {
  const handlers: DeltaHandler[] = [];
  const buffer: Delta[] = [];
  return {
    on(handler: DeltaHandler) {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i >= 0) handlers.splice(i, 1);
      };
    },
    emit(delta: Delta) {
      buffer.push(delta);
      for (const h of handlers) {
        try {
          h(delta);
        } catch {
          // handler errors never break the fan-out
        }
      }
    },
    buffered() {
      return buffer.slice();
    },
  };
}