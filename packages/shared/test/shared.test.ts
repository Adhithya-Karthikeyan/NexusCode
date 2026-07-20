/**
 * Unit tests for the @nexuscode/shared frozen contracts — the foundational,
 * zero-runtime-dep helpers every provider adapter and the kernel rely on. These
 * are pure and fully offline (no provider, no network, no filesystem). They lock
 * the contract behavior that the rest of the monorepo builds on:
 *   - AdapterError retryability defaults + JSON-safe serialization (no secrets/cause)
 *   - NexusError code/detail/cause plumbing + type guards
 *   - Usage cost math + aggregation (config-driven pricing, cache-rate fallback)
 *   - StreamChunk preamble/terminal classification
 *   - Message helpers (userText / textOf)
 */

import { describe, it, expect } from "vitest";
import {
  AdapterError,
  NexusError,
  isAdapterError,
  isNexusError,
  computeCost,
  sumUsage,
  isPreamble,
  isTerminal,
  userText,
  textOf,
  type Usage,
  type Pricing,
  type StreamChunk,
  type Message,
} from "../src/index.js";

describe("AdapterError — retryability defaults", () => {
  it("defaults rate_limit / overloaded / transport to retryable", () => {
    expect(new AdapterError("rate_limit", "slow down").retryable).toBe(true);
    expect(new AdapterError("overloaded", "busy").retryable).toBe(true);
    expect(new AdapterError("transport", "socket reset").retryable).toBe(true);
  });

  it("defaults every other code to non-retryable", () => {
    for (const code of ["auth", "invalid_request", "context_length", "content_filter", "cancelled", "cli_exit", "parse", "empty_output", "unknown"] as const) {
      expect(new AdapterError(code, "x").retryable).toBe(false);
    }
  });

  it("honors an explicit retryable override in both directions", () => {
    expect(new AdapterError("auth", "x", { retryable: true }).retryable).toBe(true);
    expect(new AdapterError("rate_limit", "x", { retryable: false }).retryable).toBe(false);
  });

  it("is an instanceof Error and carries the cause without serializing it", () => {
    const cause = new Error("underlying");
    const e = new AdapterError("transport", "boom", { cause });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("AdapterError");
    expect(e.cause).toBe(cause);
  });
});

describe("AdapterError.toJSON — audit-log-safe projection", () => {
  it("emits the base shape and omits undefined optionals", () => {
    const json = new AdapterError("parse", "bad json").toJSON();
    expect(json).toEqual({ name: "AdapterError", code: "parse", message: "bad json", retryable: false });
    expect(json).not.toHaveProperty("httpStatus");
    expect(json).not.toHaveProperty("cause");
  });

  it("includes only the provided optional fields and never the cause", () => {
    const json = new AdapterError("rate_limit", "429", {
      httpStatus: 429,
      exitCode: null,
      providerId: "openai",
      retryAfterMs: 2500,
      cause: { secret: "sk-should-not-leak" },
    }).toJSON();
    expect(json).toEqual({
      name: "AdapterError",
      code: "rate_limit",
      message: "429",
      retryable: true,
      httpStatus: 429,
      exitCode: null,
      providerId: "openai",
      retryAfterMs: 2500,
    });
    expect(JSON.stringify(json)).not.toContain("sk-should-not-leak");
  });
});

describe("NexusError", () => {
  it("carries code, detail, and cause; is an Error", () => {
    const cause = new Error("root");
    const e = new NexusError("config_invalid", "bad config", { detail: { key: "model" }, cause });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("NexusError");
    expect(e.code).toBe("config_invalid");
    expect(e.detail).toEqual({ key: "model" });
    expect(e.cause).toBe(cause);
  });

  it("leaves detail undefined when not provided", () => {
    expect(new NexusError("internal", "x").detail).toBeUndefined();
  });
});

describe("error type guards", () => {
  it("discriminate AdapterError vs NexusError vs plain values", () => {
    const a = new AdapterError("unknown", "x");
    const n = new NexusError("internal", "x");
    expect(isAdapterError(a)).toBe(true);
    expect(isAdapterError(n)).toBe(false);
    expect(isAdapterError(new Error("x"))).toBe(false);
    expect(isAdapterError(null)).toBe(false);
    expect(isNexusError(n)).toBe(true);
    expect(isNexusError(a)).toBe(false);
    expect(isNexusError("nope")).toBe(false);
  });
});

describe("computeCost", () => {
  const p: Pricing = { inputPerMTok: 3, outputPerMTok: 15 };

  it("prices input + output per 1M tokens", () => {
    const u: Usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(computeCost(u, p)).toBeCloseTo(18, 10);
  });

  it("trusts a backend-reported cost and skips the token math entirely", () => {
    const u: Usage = { inputTokens: 999_999, outputTokens: 999_999, reportedCostUsd: 0.42 };
    expect(computeCost(u, p)).toBe(0.42);
  });

  it("prices reported cost of 0 as 0 (does not fall through to token math)", () => {
    const u: Usage = { inputTokens: 1_000_000, outputTokens: 1_000_000, reportedCostUsd: 0 };
    expect(computeCost(u, p)).toBe(0);
  });

  it("falls back to the input rate for cache tokens when no cache rate is set", () => {
    const u: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
    // both cache buckets priced at inputPerMTok (3) → 3 + 3 = 6
    expect(computeCost(u, p)).toBeCloseTo(6, 10);
  });

  it("uses dedicated cache + reasoning rates when configured", () => {
    const rich: Pricing = { inputPerMTok: 3, outputPerMTok: 15, cacheReadPerMTok: 0.3, cacheWritePerMTok: 3.75, reasoningPerMTok: 15 };
    const u: Usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      reasoningTokens: 1_000_000,
    };
    expect(computeCost(u, rich)).toBeCloseTo(0.3 + 3.75 + 15, 10);
  });

  it("prices reasoning tokens at 0 when no reasoning rate is set", () => {
    const u: Usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 1_000_000 };
    expect(computeCost(u, p)).toBe(0);
  });
});

describe("sumUsage", () => {
  it("aggregates token buckets and skips undefined entries", () => {
    const acc = sumUsage([
      { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 },
      undefined,
      { inputTokens: 20, outputTokens: 7, reasoningTokens: 3 },
    ]);
    expect(acc.inputTokens).toBe(30);
    expect(acc.outputTokens).toBe(12);
    expect(acc.cacheReadTokens).toBe(2);
    expect(acc.reasoningTokens).toBe(3);
  });

  it("omits optional buckets that summed to zero", () => {
    const acc = sumUsage([{ inputTokens: 1, outputTokens: 1 }]);
    expect(acc).not.toHaveProperty("cacheReadTokens");
    expect(acc).not.toHaveProperty("cacheWriteTokens");
    expect(acc).not.toHaveProperty("reasoningTokens");
    expect(acc).not.toHaveProperty("costUsd");
  });

  it("sums cost from either costUsd or reportedCostUsd and sets it only when seen", () => {
    const acc = sumUsage([
      { inputTokens: 0, outputTokens: 0, costUsd: 0.01 },
      { inputTokens: 0, outputTokens: 0, reportedCostUsd: 0.02 },
      { inputTokens: 0, outputTokens: 0 },
    ]);
    expect(acc.costUsd).toBeCloseTo(0.03, 10);
  });

  it("returns a zeroed aggregate for an empty list", () => {
    expect(sumUsage([])).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});

describe("StreamChunk classification", () => {
  const mk = (type: StreamChunk["type"]): StreamChunk => ({ type, runId: "r1" } as unknown as StreamChunk);

  it("isPreamble is true only for run-start and session-init", () => {
    expect(isPreamble(mk("run-start"))).toBe(true);
    expect(isPreamble(mk("session-init"))).toBe(true);
    expect(isPreamble(mk("text-delta"))).toBe(false);
    expect(isPreamble(mk("run-end"))).toBe(false);
  });

  it("isTerminal is true only for run-end and error", () => {
    expect(isTerminal(mk("run-end"))).toBe(true);
    expect(isTerminal(mk("error"))).toBe(true);
    expect(isTerminal(mk("text-delta"))).toBe(false);
    expect(isTerminal(mk("run-start"))).toBe(false);
  });
});

describe("message helpers", () => {
  it("userText builds a single user text message", () => {
    expect(userText("hi")).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("textOf concatenates text blocks and ignores non-text content", () => {
    const m: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello, " },
        { type: "image", mime: "image/png", data: "..." },
        { type: "text", text: "world" },
        { type: "thinking", text: "(private)" },
      ],
    };
    expect(textOf(m)).toBe("Hello, world");
  });

  it("textOf returns an empty string when there is no text block", () => {
    expect(textOf({ role: "tool", content: [{ type: "tool_result", toolCallId: "t", content: [] }] })).toBe("");
  });
});
