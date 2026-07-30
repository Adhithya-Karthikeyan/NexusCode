import { describe, it, expect } from "vitest";
import {
  reasoningUnavailableForOAuth,
  toNativeRequest,
  type AnthropicConfig,
} from "@nexuscode/provider-anthropic";
import type { ChatRequest } from "@nexuscode/shared";

/**
 * `toNativeRequest` — the pure request-building function `stream()` calls —
 * is where `req.reasoning` becomes the wire's `thinking` block. Pure and
 * exported, so this is verified with no network, no SDK client, no key.
 *
 * The reported bug: nothing set `req.reasoning.enabled` since the CLI's
 * `--effort` flag was removed (config's `defaultEffort` defaulted to "off"
 * everywhere), so `thinking` was never attached and the app's "Show
 * reasoning traces" button had nothing to reveal — a REAL run confirmed zero
 * `reasoning` events (`session, text×3, usage, turn_end, done`). The actual
 * fix lives in `packages/cli/src/model-switch.ts`'s `implicitEffortDefaultFor`
 * (the "medium"-by-default policy for the token-budget family) and
 * `packages/cli/src/commands.ts`'s `applyEffort` — this file proves the
 * ADAPTER's half of that chain: once `req.reasoning.enabled` is true, the
 * wire request genuinely carries `thinking`.
 */
const cfg: AnthropicConfig = { modelMap: { claude: "claude-sonnet-4-5" } };

function req(reasoning?: ChatRequest["reasoning"]): ChatRequest {
  return {
    model: "claude",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...(reasoning ? { reasoning } : {}),
  };
}

describe("anthropic — reasoning.enabled reaches the wire as `thinking`", () => {
  it("enabled + budgetTokens attaches thinking:{type:'enabled', budget_tokens}", () => {
    const native = toNativeRequest(cfg, req({ enabled: true, effort: "medium", budgetTokens: 10_000 }));
    expect((native as unknown as { thinking?: unknown }).thinking).toEqual({
      type: "enabled",
      budget_tokens: 10_000,
    });
  });

  it("enabled with NO budgetTokens falls back to cfg.defaultThinkingBudget (default 8000)", () => {
    const native = toNativeRequest(cfg, req({ enabled: true, effort: "medium" }));
    expect((native as unknown as { thinking?: unknown }).thinking).toEqual({
      type: "enabled",
      budget_tokens: 8_000,
    });
    const customCfg: AnthropicConfig = { ...cfg, defaultThinkingBudget: 12_000 };
    const native2 = toNativeRequest(customCfg, req({ enabled: true, effort: "medium" }));
    expect((native2 as unknown as { thinking?: unknown }).thinking).toEqual({
      type: "enabled",
      budget_tokens: 12_000,
    });
  });

  it("req.reasoning ABSENT entirely: no thinking key at all — the adapter makes no unilateral decision", () => {
    const native = toNativeRequest(cfg, req());
    expect((native as unknown as { thinking?: unknown }).thinking).toBeUndefined();
  });

  it("req.reasoning.enabled === false: no thinking key — an explicit 'off' stays off", () => {
    const native = toNativeRequest(cfg, req({ enabled: false }));
    expect((native as unknown as { thinking?: unknown }).thinking).toBeUndefined();
  });

  it("a provider-native effort STRING (e.g. claude-code's 'xhigh') is harmless here — the anthropic adapter reads only budgetTokens, never `effort`", () => {
    const native = toNativeRequest(cfg, req({ enabled: true, effort: "xhigh", budgetTokens: 24_000 }));
    expect((native as unknown as { thinking?: unknown }).thinking).toEqual({
      type: "enabled",
      budget_tokens: 24_000,
    });
  });
});

/**
 * Real Anthropic API constraint: `max_tokens` must exceed
 * `thinking.budget_tokens` (the thinking budget counts toward the response
 * ceiling, leaving room for the answer after it). The CLI has no
 * `--max-tokens` flag at all, so `req.maxTokens` is ALWAYS unset in
 * practice — meaning the adapter's own DEFAULT `max_tokens` (4096) was
 * smaller than `EFFORT_BUDGET_TOKENS`'s "medium" (10,000) and "high"
 * (24,000) on EVERY reasoning-enabled request this adapter ever built. This
 * is exactly the kind of gap `reasoning.test.ts`'s original assertions
 * (checking only `thinking`, never `max_tokens`) could not catch — found
 * instead by `packages/cli/test/effort-anthropic-wire.integration.test.ts`
 * driving the REAL adapter against a real HTTP server and inspecting the
 * actual JSON body.
 */
describe("anthropic — max_tokens accommodates the thinking budget (a real API constraint)", () => {
  it("the DEFAULT max_tokens (4096) is too small for 'medium' (10k)/'high' (24k) — bumped up with headroom for the answer", () => {
    const mediumNative = toNativeRequest(cfg, req({ enabled: true, effort: "medium", budgetTokens: 10_000 }));
    expect(mediumNative.max_tokens).toBeGreaterThan(10_000);
    expect(mediumNative.max_tokens).toBe(10_000 + 1024);

    const highNative = toNativeRequest(cfg, req({ enabled: true, effort: "high", budgetTokens: 24_000 }));
    expect(highNative.max_tokens).toBeGreaterThan(24_000);
    expect(highNative.max_tokens).toBe(24_000 + 1024);
  });

  it("'low' (4k) already fits under the default 4096 headroom-adjusted, so it still gets the bump (never leaves zero room for the answer)", () => {
    const native = toNativeRequest(cfg, req({ enabled: true, effort: "low", budgetTokens: 4_000 }));
    expect(native.max_tokens).toBe(4_000 + 1024);
  });

  it("an EXPLICIT cfg.defaultMaxTokens/req.maxTokens already large enough is left completely unchanged", () => {
    const bigCfg: AnthropicConfig = { ...cfg, defaultMaxTokens: 50_000 };
    const native = toNativeRequest(bigCfg, req({ enabled: true, effort: "high", budgetTokens: 24_000 }));
    expect(native.max_tokens).toBe(50_000);
  });

  it("reasoning disabled/absent: max_tokens is completely untouched (still just the plain default/explicit value)", () => {
    const native = toNativeRequest(cfg, req());
    expect(native.max_tokens).toBe(4096);
    const explicit = toNativeRequest(cfg, { ...req(), maxTokens: 500 });
    expect(explicit.max_tokens).toBe(500);
  });
});

describe("extended thinking is not sent on a Claude subscription OAuth token", () => {
  // Verified on a live account by capturing the literal request bytes: with a
  // bearer credential the API accepted `thinking:{type:"enabled",
  // budget_tokens:24000}` alongside `max_tokens:25024`, returned **200**, and
  // omitted every thinking block. So the parameter is silently ignored, not
  // rejected — which is why this looked like a wiring bug for three rounds and
  // why no error ever surfaced. Sending it anyway would leave the product's
  // effort control looking functional while doing nothing.
  it("omits `thinking` for a bearer credential but keeps it for an api key", () => {
    const cfg: AnthropicConfig = { modelMap: {} };
    const reasoning = { enabled: true, effort: "high", budgetTokens: 24_000 };

    const viaOAuth = toNativeRequest(cfg, req(reasoning), true) as unknown as Record<string, unknown>;
    expect(viaOAuth["thinking"]).toBeUndefined();

    const viaApiKey = toNativeRequest(cfg, req(reasoning), false) as unknown as Record<string, unknown>;
    expect(viaApiKey["thinking"]).toEqual({ type: "enabled", budget_tokens: 24_000 });
  });

  it("does not inflate max_tokens for a budget it is not going to send", () => {
    // The `max_tokens` sizing exists ONLY to satisfy Anthropic's constraint
    // that it exceed `thinking.budget_tokens`. With no thinking sent there is
    // no constraint, so silently requesting 25k output would be a real cost
    // and latency change for a request that gains nothing by it.
    const cfg: AnthropicConfig = { modelMap: {}, defaultMaxTokens: 4096 };
    const viaOAuth = toNativeRequest(
      cfg,
      req({ enabled: true, effort: "high", budgetTokens: 24_000 }),
      true,
    ) as unknown as Record<string, unknown>;
    expect(viaOAuth["max_tokens"]).toBe(4096);
  });

  it("reports the unavailability so a caller can warn instead of failing silently", () => {
    const enabled = req({ enabled: true, effort: "high", budgetTokens: 24_000 });
    expect(reasoningUnavailableForOAuth(enabled, true)).toBe(true);
    // Not "unavailable" when nothing was asked for, and not for an api key.
    expect(reasoningUnavailableForOAuth(enabled, false)).toBe(false);
    expect(reasoningUnavailableForOAuth(req(undefined), true)).toBe(false);
  });
});
