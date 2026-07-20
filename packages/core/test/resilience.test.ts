import { describe, it, expect } from "vitest";
import { withRetry, backoffDelay, DEFAULT_RETRY_POLICY, type RetryPolicy } from "@nexuscode/core";
import { AdapterError, type Message, type StreamChunk } from "@nexuscode/shared";

const FAST: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2, jitter: 0 };

const MSG: Message = { role: "assistant", content: [{ type: "text", text: "ok" }] };

function errorChunk(retryable: boolean): StreamChunk {
  return {
    type: "error",
    runId: "",
    error: new AdapterError("rate_limit", "transient", { retryable }),
    retryable,
  };
}

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe("withRetry — retry only before the first content chunk", () => {
  it("retries a retryable error that arrives before any content, then succeeds", async () => {
    let attempts = 0;
    const make = (attempt: number): AsyncIterable<StreamChunk> => {
      attempts++;
      return (async function* () {
        if (attempt === 1) {
          yield errorChunk(true);
          return;
        }
        yield { type: "run-start", runId: "", adapterId: "x", model: "m", ts: 0 };
        yield { type: "text-delta", runId: "", text: "ok" };
        yield { type: "run-end", runId: "", finishReason: "stop", message: MSG, ts: 0 };
      })();
    };

    const chunks = await collect(withRetry(make, FAST, new AbortController().signal));
    expect(attempts).toBe(2);
    expect(chunks.some((c) => c.type === "run-end")).toBe(true);
    expect(chunks.some((c) => c.type === "error")).toBe(false);
  });

  it("does NOT retry once real content has streamed (no replay / dedupe)", async () => {
    let attempts = 0;
    const make = (): AsyncIterable<StreamChunk> => {
      attempts++;
      return (async function* () {
        yield { type: "run-start", runId: "", adapterId: "x", model: "m", ts: 0 };
        yield { type: "text-delta", runId: "", text: "partial" };
        yield errorChunk(true);
      })();
    };

    const chunks = await collect(withRetry(make, FAST, new AbortController().signal));
    expect(attempts).toBe(1);
    // The single text delta is emitted exactly once — never replayed.
    expect(chunks.filter((c) => c.type === "text-delta")).toHaveLength(1);
    expect(chunks[chunks.length - 1]?.type).toBe("error");
  });

  it("honors maxAttempts when the error keeps recurring before content", async () => {
    let attempts = 0;
    const make = (): AsyncIterable<StreamChunk> => {
      attempts++;
      return (async function* () {
        yield errorChunk(true);
      })();
    };

    const chunks = await collect(withRetry(make, FAST, new AbortController().signal));
    expect(attempts).toBe(FAST.maxAttempts);
    expect(chunks[chunks.length - 1]?.type).toBe("error");
  });

  it("does not retry a non-retryable error", async () => {
    let attempts = 0;
    const make = (): AsyncIterable<StreamChunk> => {
      attempts++;
      return (async function* () {
        yield errorChunk(false);
      })();
    };
    const chunks = await collect(withRetry(make, FAST, new AbortController().signal));
    expect(attempts).toBe(1);
    expect(chunks[chunks.length - 1]?.type).toBe("error");
  });

  it("emits a cancelled error immediately when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let attempts = 0;
    const make = (): AsyncIterable<StreamChunk> => {
      attempts++;
      return (async function* () {
        yield { type: "text-delta", runId: "", text: "should not run" };
      })();
    };
    const chunks = await collect(withRetry(make, FAST, ac.signal));
    expect(attempts).toBe(0);
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type === "error") expect(last.error.code).toBe("cancelled");
  });
});

describe("backoffDelay", () => {
  it("honors an explicit Retry-After above the computed backoff", () => {
    const err = new AdapterError("rate_limit", "slow", { retryAfterMs: 1234 });
    expect(backoffDelay(1, FAST, err)).toBe(1234);
  });

  it("grows exponentially and is capped by maxDelayMs", () => {
    const policy: RetryPolicy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 250, jitter: 0 };
    expect(backoffDelay(1, policy)).toBe(100);
    expect(backoffDelay(2, policy)).toBe(200);
    expect(backoffDelay(3, policy)).toBe(250); // 400 capped to 250
  });

  it("exposes a sane default policy", () => {
    expect(DEFAULT_RETRY_POLICY.maxAttempts).toBeGreaterThanOrEqual(1);
  });
});
