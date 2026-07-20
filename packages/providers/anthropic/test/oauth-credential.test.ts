import { describe, it, expect } from "vitest";
import {
  buildAnthropicClientOptions,
  createAnthropicAdapter,
  toNativeRequest,
} from "@nexuscode/provider-anthropic";
import type { AnthropicConfig } from "@nexuscode/provider-anthropic";
import type { ChatRequest } from "@nexuscode/shared";

/**
 * The credential → header wiring for the native Anthropic adapter, verified as a
 * pure function with no network and no live SDK request:
 *
 *  - a "bearer" credential (an OAuth access token — "login like Claude Code")
 *    sets `authToken` (→ Authorization: Bearer), nulls `apiKey` (never an
 *    x-api-key alongside), and opts into the OAuth beta header;
 *  - an "api-key" credential sets `apiKey` (→ x-api-key) and no authToken;
 *  - static defaultHeaders survive; an explicit anthropic-beta is not clobbered.
 */
const cfg: AnthropicConfig = { modelMap: { claude: "claude-3-5-sonnet-latest" } };

describe("Anthropic adapter picks up an OAuth Bearer token", () => {
  it("bearer credential → authToken + beta header, no api key", () => {
    const opts = buildAnthropicClientOptions(cfg, { kind: "bearer", value: "oat-abc123" });
    expect(opts.authToken).toBe("oat-abc123");
    expect(opts.apiKey).toBeNull();
    expect(opts.maxRetries).toBe(0);
    expect(opts.defaultHeaders?.["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("api-key credential → apiKey (x-api-key), no authToken or beta header", () => {
    const opts = buildAnthropicClientOptions(cfg, { kind: "api-key", value: "sk-ant-key" });
    expect(opts.apiKey).toBe("sk-ant-key");
    expect(opts.authToken).toBeUndefined();
    expect(opts.defaultHeaders?.["anthropic-beta"]).toBeUndefined();
  });

  it("preserves static defaultHeaders and honors a caller-set anthropic-beta", () => {
    const withHeaders: AnthropicConfig = {
      modelMap: cfg.modelMap,
      defaultHeaders: { "x-org-id": "org_1", "anthropic-beta": "custom-beta" },
    };
    const opts = buildAnthropicClientOptions(withHeaders, { kind: "bearer", value: "oat" });
    expect(opts.defaultHeaders?.["x-org-id"]).toBe("org_1");
    // A caller-provided anthropic-beta is not overwritten.
    expect(opts.defaultHeaders?.["anthropic-beta"]).toBe("custom-beta");
  });

  it("a 'none' credential yields an empty api key (auth error surfaces only on use)", () => {
    const opts = buildAnthropicClientOptions(cfg, { kind: "none", value: "" });
    expect(opts.apiKey).toBe("");
    expect(opts.authToken).toBeUndefined();
  });

  it("createAnthropicAdapter accepts an OAuth-aware credential source (constructs offline)", async () => {
    const adapter = createAnthropicAdapter(
      { ...cfg, credential: async () => ({ kind: "bearer", value: "oat-live" }) },
      async () => "unused-api-key",
    );
    expect(adapter.id).toBe("anthropic");
    // health() resolves the credential + builds the client without a network call.
    const ac = new AbortController();
    const status = await adapter.health!({
      signal: ac.signal,
      idempotencyKey: "t",
      traceId: "t",
      runId: "t",
    });
    expect(status.ok).toBe(true);
  });

  it("re-resolves the credential per use so a mid-session token refresh is picked up", async () => {
    // Simulate @nexuscode/auth auto-refreshing the OAuth Bearer mid-session: the
    // credential source hands back a NEW access token on each call. A one-shot
    // cache (`if (!client)`) would resolve only once and keep sending the stale
    // token → 401. The adapter must invoke the source on EVERY use.
    const tokens = ["oat-v1", "oat-v2", "oat-v3"];
    let calls = 0;
    const adapter = createAnthropicAdapter(
      {
        ...cfg,
        credential: async () => ({ kind: "bearer", value: tokens[calls++] ?? "oat-final" }),
      },
      async () => "unused-api-key",
    );
    const ctx = (id: string) => ({
      signal: new AbortController().signal,
      idempotencyKey: id,
      traceId: id,
      runId: id,
    });
    await adapter.health!(ctx("a"));
    await adapter.health!(ctx("b"));
    await adapter.health!(ctx("c"));
    // Per-request resolution: the source is consulted on every getClient() call,
    // not memoized once — this is what lets a rotated token take effect.
    expect(calls).toBe(3);
  });
});

/**
 * A Claude.ai *subscription* OAuth token is rejected by `POST /v1/messages`
 * (401, empty turn) unless the FIRST system block identifies the caller as
 * Claude Code — the exact quirk that made a logged-in `nexus` show an empty
 * assistant bubble. `toNativeRequest(cfg, req, oauth)` must inject that identity
 * block for OAuth bearer requests, and leave console api-key requests untouched.
 */
describe("Anthropic OAuth requests carry the Claude Code identity system block", () => {
  const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
  const cfg: AnthropicConfig = { modelMap: {} };
  const req: ChatRequest = {
    model: "claude-opus-4-7",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    system: "Be terse.",
  };

  it("oauth=true → identity is the FIRST system block, caller system preserved second", () => {
    const out = toNativeRequest(cfg, req, true);
    expect(Array.isArray(out.system)).toBe(true);
    const blocks = out.system as Array<{ type: string; text: string }>;
    expect(blocks[0]).toEqual({ type: "text", text: CLAUDE_CODE_IDENTITY });
    expect(blocks[1]).toEqual({ type: "text", text: "Be terse." });
  });

  it("oauth=true with no caller system → identity is the sole system block", () => {
    const out = toNativeRequest(cfg, { ...req, system: undefined }, true);
    const blocks = out.system as Array<{ type: string; text: string }>;
    expect(blocks).toEqual([{ type: "text", text: CLAUDE_CODE_IDENTITY }]);
  });

  it("api-key path (oauth=false / omitted) keeps the plain string system, no identity", () => {
    expect(toNativeRequest(cfg, req, false).system).toBe("Be terse.");
    // default arg is false → back-compat with existing offline shape tests.
    expect(toNativeRequest(cfg, req).system).toBe("Be terse.");
  });
});
