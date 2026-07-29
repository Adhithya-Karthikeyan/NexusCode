import { describe, it, expect } from "vitest";
import { toNativeRequest, type AnthropicConfig } from "@nexuscode/provider-anthropic";
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
