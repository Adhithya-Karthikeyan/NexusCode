/**
 * Centralized retries & backoff. Adapters set their own SDK retries to 0 and
 * defer to this policy so every backend behaves identically.
 *
 * Critical invariant: retry ONLY before the first non-preamble chunk is yielded.
 * Once real output has streamed we never replay — that would double-charge
 * tokens or re-apply edits.
 */

import { AdapterError, type StreamChunk } from "@nexuscode/shared";
import { enforceStreamContract } from "./stream-contract.js";

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Fraction of the base delay added as random jitter (0..1). */
  jitter: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  jitter: 0.3,
};

/** Abortable sleep; resolves early if the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    // NOTE: do not unref — an in-progress backoff is real work and must keep
    // the process alive until it resolves (or the signal aborts it early).
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Compute the delay before the next attempt, honoring `Retry-After` first. */
export function backoffDelay(attempt: number, policy: RetryPolicy, err?: AdapterError): number {
  const retryAfter = err?.opts.retryAfterMs;
  if (retryAfter != null && retryAfter >= 0) return retryAfter;
  const base = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxDelayMs, base + jitter);
}

async function backoff(
  attempt: number,
  policy: RetryPolicy,
  err: AdapterError | undefined,
  signal: AbortSignal,
): Promise<void> {
  await sleep(backoffDelay(attempt, policy, err), signal);
}

/**
 * Wrap an attempt-producing factory with retry-before-first-chunk semantics.
 * `make(attempt)` must produce a fresh stream for each attempt.
 */
export async function* withRetry(
  make: (attempt: number) => AsyncIterable<StreamChunk>,
  policy: RetryPolicy,
  signal: AbortSignal,
): AsyncIterable<StreamChunk> {
  for (let attempt = 1; ; attempt++) {
    if (signal.aborted) {
      yield { type: "error", runId: "", error: new AdapterError("cancelled", "aborted"), retryable: false };
      return;
    }

    // Do not publish an attempt's run/session preamble until that attempt
    // commits. Otherwise a retry-before-first-output leaks duplicate run-starts
    // into the TUI/history and makes one user turn look like multiple sessions.
    const preamble: StreamChunk[] = [];
    const flushPreamble = function* (): Generator<StreamChunk> {
      yield* preamble;
      preamble.length = 0;
    };

    let committed = false;
    let willRetry = false;
    let providerId: string | undefined;
    let sawAnswer = false;
    let sawReasoning = false;
    const startedTools = new Set<string>();
    const endedTools = new Set<string>();

    try {
      for await (const chunk of enforceStreamContract(make(attempt))) {
        if (chunk.type === "run-start") providerId = chunk.adapterId;

        // Usage can arrive before an error/empty terminal. Buffer it with the
        // preamble so a failed, retried attempt does not publish duplicate
        // accounting or prevent cross-provider failover.
        if (
          !committed &&
          (chunk.type === "run-start" || chunk.type === "session-init" || chunk.type === "usage")
        ) {
          preamble.push(chunk);
          continue;
        }

        // A retryable error before any real output → back off and retry.
        if (chunk.type === "error") {
          if (!committed && chunk.error.retryable && attempt < policy.maxAttempts) {
            willRetry = true;
            await backoff(attempt, policy, chunk.error, signal);
            break;
          }
          yield* flushPreamble();
          yield chunk;
          return;
        }

        if (chunk.type === "run-end") {
          const terminalError = errorForRunEnd(chunk, providerId);
          if (terminalError) {
            yield* flushPreamble();
            yield {
              type: "error",
              runId: chunk.runId,
              error: terminalError,
              retryable: terminalError.retryable,
              ...(chunk.raw !== undefined ? { raw: chunk.raw } : {}),
            };
            return;
          }

          // Some SDK/proxy streams send only a final message and no deltas.
          // Recover those blocks into canonical chunks so live consumers and
          // the result builder see exactly the same answer/tool activity.
          for (const recovered of recoverTerminalContent(
            chunk,
            sawAnswer,
            sawReasoning,
            startedTools,
            endedTools,
          )) {
            yield* flushPreamble();
            committed = true;
            yield recovered;
          }
          yield* flushPreamble();
          yield chunk;
          return;
        }

        if (chunk.type === "text-delta" && chunk.channel !== "reasoning" && chunk.text.trim().length > 0) {
          sawAnswer = true;
        } else if (
          (chunk.type === "reasoning-delta" ||
            (chunk.type === "text-delta" && chunk.channel === "reasoning")) &&
          chunk.text.trim().length > 0
        ) {
          sawReasoning = true;
        } else if (chunk.type === "tool-call-start") {
          startedTools.add(chunk.id);
        } else if (chunk.type === "tool-call-end") {
          endedTools.add(chunk.id);
        }

        yield* flushPreamble();
        committed = true;
        yield chunk;
      }
    } catch (e) {
      if (signal.aborted) {
        yield { type: "error", runId: "", error: new AdapterError("cancelled", "aborted"), retryable: false };
        return;
      }
      const err = e instanceof AdapterError ? e : new AdapterError("transport", String(e), { cause: e });
      if (!committed && err.retryable && attempt < policy.maxAttempts) {
        await backoff(attempt, policy, err, signal);
        continue;
      }
      yield* flushPreamble();
      yield { type: "error", runId: "", error: err, retryable: err.retryable };
      return;
    }

    if (willRetry) continue;
    // Enforce the shared stream contract at the kernel boundary. Previously the
    // result builder noticed this only after live consumers had already seen an
    // empty stream, which is the user-visible "Nexus returned nothing" failure.
    const err = new AdapterError("empty_output", "provider stream ended without a terminal response", {
      ...(providerId !== undefined ? { providerId } : {}),
    });
    yield* flushPreamble();
    yield { type: "error", runId: "", error: err, retryable: false };
    return;
  }
}

/** Convert terminal finish states that cannot be presented as a successful turn. */
function errorForRunEnd(
  chunk: Extract<StreamChunk, { type: "run-end" }>,
  providerId: string | undefined,
): AdapterError | undefined {
  const opts = providerId !== undefined ? { providerId } : {};
  const terminalText = chunk.message.content
    .filter((b): b is Extract<(typeof chunk.message.content)[number], { type: "text" }> => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  if (chunk.finishReason === "content_filter") {
    const detail = terminalText ? `: ${terminalText}` : "";
    return new AdapterError(
      "content_filter",
      `provider blocked the response because of its content or safety policy${detail}`,
      opts,
    );
  }
  if (chunk.finishReason === "cancelled") {
    return new AdapterError("cancelled", "provider cancelled the response", opts);
  }
  if (chunk.finishReason === "error") {
    return new AdapterError(
      "unknown",
      terminalText || "provider ended the response with an unspecified error",
      opts,
    );
  }

  const hasRenderableContent = chunk.message.content.some((b) => {
    if (b.type === "text" || b.type === "thinking") return b.text.trim().length > 0;
    return b.type === "tool_use";
  });
  if (!hasRenderableContent) {
    const suffix =
      chunk.finishReason === "length" ? " before producing content (output limit reached)" : "";
    return new AdapterError("empty_output", `provider completed with no response content${suffix}`, opts);
  }
  return undefined;
}

/**
 * Recover final-only provider responses into ordinary deltas/tool chunks.
 * Adapters should normally stream these already; this is the provider-neutral
 * safety net for SDK/proxy edge cases.
 */
function* recoverTerminalContent(
  chunk: Extract<StreamChunk, { type: "run-end" }>,
  sawAnswer: boolean,
  sawReasoning: boolean,
  startedTools: ReadonlySet<string>,
  endedTools: ReadonlySet<string>,
): Generator<StreamChunk> {
  for (const block of chunk.message.content) {
    if (block.type === "text" && !sawAnswer && block.text.length > 0) {
      sawAnswer = true;
      yield {
        type: "text-delta",
        runId: chunk.runId,
        text: block.text,
        channel: "answer",
        ...(chunk.raw !== undefined ? { raw: chunk.raw } : {}),
      };
    } else if (block.type === "thinking" && !sawReasoning && block.text.length > 0) {
      sawReasoning = true;
      yield {
        type: "reasoning-delta",
        runId: chunk.runId,
        text: block.text,
        ...(chunk.raw !== undefined ? { raw: chunk.raw } : {}),
      };
    } else if (block.type === "tool_use" && !endedTools.has(block.id)) {
      if (!startedTools.has(block.id)) {
        yield {
          type: "tool-call-start",
          runId: chunk.runId,
          id: block.id,
          name: block.name,
          ...(chunk.raw !== undefined ? { raw: chunk.raw } : {}),
        };
      }
      yield {
        type: "tool-call-end",
        runId: chunk.runId,
        id: block.id,
        input: block.input,
        ...(chunk.raw !== undefined ? { raw: chunk.raw } : {}),
      };
    }
  }
}
