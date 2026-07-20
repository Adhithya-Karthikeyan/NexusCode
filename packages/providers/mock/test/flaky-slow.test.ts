import { describe, it, expect } from "vitest";
import { createFlakyMockAdapter, createSlowMockAdapter } from "@nexuscode/provider-mock";
import type { CallContext } from "@nexuscode/core";
import type { ChatRequest, StreamChunk } from "@nexuscode/shared";

function ctx(signal: AbortSignal, runId = "run_test"): CallContext {
  return { signal, idempotencyKey: "idem_test", traceId: "trace_test", runId };
}

function req(text: string, model = "mock-fast"): ChatRequest {
  return { model, messages: [{ role: "user", content: [{ type: "text", text }] }] };
}

async function collect(iter: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of iter) out.push(c);
  return out;
}

describe("mock-flaky — fails then succeeds", () => {
  it("fails the first K attempts with a retryable error, then succeeds (chat)", async () => {
    const adapter = createFlakyMockAdapter({ failCount: 2 });
    const signal = new AbortController().signal;

    // Attempt 1 + 2 fail with a retryable error.
    for (const attempt of [1, 2]) {
      await expect(adapter.chat(req("hi"), ctx(signal))).rejects.toMatchObject({
        code: "overloaded",
        retryable: true,
      });
      expect(attempt).toBeLessThanOrEqual(2);
    }

    // Attempt 3 succeeds deterministically.
    const result = await adapter.chat(req("hi"), ctx(signal));
    expect(result.finishReason).toBe("stop");
    const text = result.message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(text).toContain("hi");
  });

  it("emits run-start then a retryable error chunk while failing (stream)", async () => {
    const adapter = createFlakyMockAdapter({ failCount: 1 });
    const chunks = await collect(adapter.stream(req("x"), ctx(new AbortController().signal)));
    expect(chunks[0]?.type).toBe("run-start");
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type !== "error") throw new Error("expected error");
    expect(last.retryable).toBe(true);
    expect(chunks.some((c) => c.type === "run-end")).toBe(false);
  });

  it("counter is per-instance: a fresh adapter fails again from scratch", async () => {
    const a = createFlakyMockAdapter({ failCount: 1 });
    await expect(a.chat(req("q"), ctx(new AbortController().signal))).rejects.toBeTruthy();
    await expect(a.chat(req("q"), ctx(new AbortController().signal))).resolves.toBeTruthy();

    const b = createFlakyMockAdapter({ failCount: 1 });
    await expect(b.chat(req("q"), ctx(new AbortController().signal))).rejects.toBeTruthy();
  });

  it("honors a custom failCode and default id/label", async () => {
    const adapter = createFlakyMockAdapter({ failCount: 1, failCode: "rate_limit" });
    expect(adapter.id).toBe("mock-flaky");
    await expect(adapter.chat(req("x"), ctx(new AbortController().signal))).rejects.toMatchObject({
      code: "rate_limit",
    });
  });

  it("with failCount Infinity it always fails", async () => {
    const adapter = createFlakyMockAdapter({ failCount: Infinity });
    for (let i = 0; i < 5; i++) {
      await expect(adapter.chat(req("x"), ctx(new AbortController().signal))).rejects.toBeTruthy();
    }
  });
});

describe("mock-slow — configurable latency", () => {
  it("delays time-to-first-chunk by at least startupDelayMs", async () => {
    const startupDelayMs = 60;
    const adapter = createSlowMockAdapter({ startupDelayMs });
    const start = Date.now();
    let firstAt = 0;
    for await (const c of adapter.stream(req("hi"), ctx(new AbortController().signal))) {
      if (firstAt === 0) firstAt = Date.now();
      void c;
    }
    const elapsed = firstAt - start;
    // Real timers never fire early — a lower bound is robust (allow small slack).
    expect(elapsed).toBeGreaterThanOrEqual(startupDelayMs - 15);
    expect(adapter.id).toBe("mock-slow");
  });

  it("a fast adapter finishes before a slow one (race ordering is deterministic)", async () => {
    const slow = createSlowMockAdapter({ startupDelayMs: 80 });
    const fast = createSlowMockAdapter({ startupDelayMs: 0 });
    const ac = new AbortController();

    const timed = async (a: typeof slow, tag: string): Promise<{ tag: string; at: number }> => {
      await a.chat(req("race"), ctx(ac.signal));
      return { tag, at: Date.now() };
    };

    const [winner] = await Promise.all([timed(fast, "fast"), timed(slow, "slow")]).then((rs) =>
      rs.sort((x, y) => x.at - y.at),
    );
    expect(winner?.tag).toBe("fast");
  });

  it("aborting during the startup delay yields a terminal cancelled error, no output", async () => {
    const adapter = createSlowMockAdapter({ startupDelayMs: 200 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const chunks = await collect(adapter.stream(req("cancel"), ctx(ac.signal)));
    const last = chunks[chunks.length - 1];
    expect(last?.type).toBe("error");
    if (last?.type !== "error") throw new Error("expected error");
    expect(last.error.code).toBe("cancelled");
    expect(chunks.some((c) => c.type === "text-delta")).toBe(false);
  });

  it("still streams a full deterministic answer once the delay elapses", async () => {
    const adapter = createSlowMockAdapter({ startupDelayMs: 10 });
    const result = await adapter.chat(req("payload"), ctx(new AbortController().signal));
    const text = result.message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    expect(text).toContain("payload");
    expect(result.finishReason).toBe("stop");
  });
});
