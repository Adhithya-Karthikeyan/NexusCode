/**
 * Defensive validator for the frozen provider stream contract.
 *
 * Provider adapters are extension points and may be supplied by plugins or
 * upgraded independently of the kernel. The type system cannot protect a live
 * async stream from duplicate starts, mismatched run ids, orphaned tool chunks,
 * or events emitted after a terminal. This boundary converts the first
 * violation into one normalized terminal parse error and closes the source.
 */

import { AdapterError, type StreamChunk } from "@nexuscode/shared";

function violation(chunk: StreamChunk, message: string, providerId?: string): StreamChunk {
  const error = new AdapterError("parse", `provider stream contract violation: ${message}`, {
    ...(providerId !== undefined ? { providerId } : {}),
  });
  return {
    type: "error",
    runId: chunk.runId,
    error,
    retryable: false,
    raw: {
      violation: message,
      chunkType: chunk.type,
    },
  };
}

/**
 * Validate and forward a provider stream.
 *
 * A terminal-only error is accepted because the resilience layer also folds
 * adapter setup failures into that shape before a provider can emit
 * `run-start`. Every non-terminal stream must start exactly once, keep one
 * runId, maintain tool-call ordering, and stop at its first terminal.
 */
export async function* enforceStreamContract(
  source: AsyncIterable<StreamChunk>,
): AsyncIterable<StreamChunk> {
  let runId: string | undefined;
  let providerId: string | undefined;
  let sawStart = false;
  let sawSessionInit = false;
  const openTools = new Set<string>();
  const closedTools = new Set<string>();

  for await (const chunk of source) {
    if (!sawStart) {
      if (chunk.type === "error") {
        yield chunk;
        return;
      }
      if (chunk.type !== "run-start") {
        yield violation(chunk, `expected run-start first, received ${chunk.type}`);
        return;
      }
      sawStart = true;
      runId = chunk.runId;
      providerId = chunk.adapterId;
      yield chunk;
      continue;
    }

    if (chunk.type === "run-start") {
      yield violation(chunk, "duplicate run-start", providerId);
      return;
    }
    if (chunk.runId !== runId) {
      yield violation(
        chunk,
        `runId changed from ${JSON.stringify(runId)} to ${JSON.stringify(chunk.runId)}`,
        providerId,
      );
      return;
    }
    if (chunk.type === "session-init") {
      if (sawSessionInit) {
        yield violation(chunk, "duplicate session-init", providerId);
        return;
      }
      sawSessionInit = true;
    } else if (chunk.type === "tool-call-start") {
      if (openTools.has(chunk.id) || closedTools.has(chunk.id)) {
        yield violation(chunk, `duplicate tool-call-start id ${JSON.stringify(chunk.id)}`, providerId);
        return;
      }
      openTools.add(chunk.id);
    } else if (chunk.type === "tool-call-delta") {
      if (!openTools.has(chunk.id)) {
        yield violation(chunk, `tool-call-delta without start for id ${JSON.stringify(chunk.id)}`, providerId);
        return;
      }
    } else if (chunk.type === "tool-call-end") {
      if (!openTools.delete(chunk.id)) {
        yield violation(chunk, `tool-call-end without start for id ${JSON.stringify(chunk.id)}`, providerId);
        return;
      }
      closedTools.add(chunk.id);
    }

    yield chunk;
    if (chunk.type === "run-end" || chunk.type === "error") return;
  }
}
