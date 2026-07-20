/**
 * Trace/span id generation, W3C Trace-Context shaped: a trace id is 16 bytes
 * (32 lowercase hex) and a span id is 8 bytes (16 hex). `randomBytes` is used
 * so ids are collision-safe across processes without a global counter.
 */

import { randomBytes } from "node:crypto";

export interface IdGenerator {
  traceId(): string;
  spanId(): string;
}

export const cryptoIdGenerator: IdGenerator = {
  traceId: () => randomBytes(16).toString("hex"),
  spanId: () => randomBytes(8).toString("hex"),
};

/**
 * Deterministic id generator for tests/snapshots: `<prefix>trace-000001`, etc.
 * Not for production traces (ids are guessable and process-local).
 */
export function sequentialIdGenerator(prefix = ""): IdGenerator {
  let t = 0;
  let s = 0;
  const pad = (n: number) => String(n).padStart(6, "0");
  return {
    traceId: () => `${prefix}trace-${pad(++t)}`,
    spanId: () => `${prefix}span-${pad(++s)}`,
  };
}
