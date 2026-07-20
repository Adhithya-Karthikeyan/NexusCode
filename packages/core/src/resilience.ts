/**
 * Centralized retries & backoff. Adapters set their own SDK retries to 0 and
 * defer to this policy so every backend behaves identically.
 *
 * Critical invariant: retry ONLY before the first non-preamble chunk is yielded.
 * Once real output has streamed we never replay — that would double-charge
 * tokens or re-apply edits.
 */

import { AdapterError, type StreamChunk } from "@nexuscode/shared";

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

    let started = false;
    let willRetry = false;

    try {
      for await (const chunk of make(attempt)) {
        // "started" means real output has streamed. Preamble (run-start /
        // session-init) and a terminal `error` are NOT content — so a retryable
        // error that arrives before any content can still be retried.
        if (
          chunk.type !== "run-start" &&
          chunk.type !== "session-init" &&
          chunk.type !== "error"
        ) {
          started = true;
        }

        // A retryable error before any real output → back off and retry.
        if (chunk.type === "error" && !started && chunk.error.retryable && attempt < policy.maxAttempts) {
          willRetry = true;
          await backoff(attempt, policy, chunk.error, signal);
          break;
        }

        yield chunk;
        if (chunk.type === "run-end" || chunk.type === "error") return;
      }
    } catch (e) {
      if (signal.aborted) {
        yield { type: "error", runId: "", error: new AdapterError("cancelled", "aborted"), retryable: false };
        return;
      }
      const err = e instanceof AdapterError ? e : new AdapterError("transport", String(e), { cause: e });
      if (!started && err.retryable && attempt < policy.maxAttempts) {
        await backoff(attempt, policy, err, signal);
        continue;
      }
      yield { type: "error", runId: "", error: err, retryable: err.retryable };
      return;
    }

    if (willRetry) continue;
    // Stream ended without a terminal chunk and without a retry request → done.
    return;
  }
}
