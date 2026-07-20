/**
 * First-run provider fallback tests (BUG: bare `nexus`/`nexus tui`/`nexus ask`
 * must never dead-end when the configured `defaultProvider` — "anthropic" per
 * schema default — has no key. `resolveDefaultProvider` (packages/cli/src/
 * runtime.ts) is the pure decision the DEFAULT (no explicit `-p`) command path
 * uses; these tests drive it against a real `buildRuntime` (offline, no
 * network) so the "anthropic is never registered without config" behavior is
 * exercised for real, not assumed.
 */
import { describe, it, expect } from "vitest";
import { NexusConfig, type SecretStore } from "@nexuscode/config";
import { buildRuntime } from "@nexuscode/runtime";
import { ProviderAuthRegistry, createAnthropicAuthStrategy, createTokenStore, type TokenSet } from "@nexuscode/auth";
import { isProviderUsable, pickFallbackProviderId, resolveDefaultProvider } from "../src/runtime.js";

const stubSecrets: SecretStore = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  source: async () => null,
};

/** A real, in-memory `SecretStore` (Map-backed) — no OS keychain, no file I/O. */
function createMemorySecretStore(): SecretStore {
  const store = new Map<string, string>();
  return {
    get: async (ref) => store.get(ref) ?? null,
    set: async (ref, value) => {
      store.set(ref, value);
    },
    delete: async (ref) => {
      store.delete(ref);
    },
    source: async (ref) => (store.has(ref) ? "file" : null),
  };
}

describe("isProviderUsable / pickFallbackProviderId — offline mock catalog", () => {
  it("mock is always usable; an unregistered id (e.g. anthropic with zero config) is not", async () => {
    const config = NexusConfig.parse({});
    const runtime = await buildRuntime(config, { secrets: stubSecrets });

    // The root cause of the first-run dead-end: with an empty `providers[]`,
    // "anthropic" is never registered at all (it is not in the always-present
    // default catalog — only mock / mock-flaky / mock-slow / the offline
    // OpenAI-compat + native catalogs are).
    expect(runtime.registry.has("anthropic")).toBe(false);
    expect(isProviderUsable(runtime, "anthropic")).toBe(false);
    expect(isProviderUsable(runtime, "mock")).toBe(true);
    expect(isProviderUsable(runtime, "totally-unknown-provider")).toBe(false);
  });

  it("picks mock first as the fallback", async () => {
    const config = NexusConfig.parse({});
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    expect(pickFallbackProviderId(runtime)).toBe("mock");
  });
});

describe("resolveDefaultProvider — the DEFAULT (no explicit -p) path", () => {
  it("returns the requested provider unchanged when it is already usable", async () => {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });

    const res = resolveDefaultProvider(runtime, config.defaultProvider);
    expect(res).toEqual({ providerId: "mock", fellBack: false, requestedId: "mock" });
  });

  it("falls back to mock when the schema-default provider (anthropic) has no key — never dead-ends", async () => {
    const config = NexusConfig.parse({}); // defaultProvider: "anthropic" (schema default)
    expect(config.defaultProvider).toBe("anthropic");
    const runtime = await buildRuntime(config, { secrets: stubSecrets });

    const res = resolveDefaultProvider(runtime, config.defaultProvider);
    expect(res).toEqual({ providerId: "mock", fellBack: true, requestedId: "anthropic" });
  });

  it("does NOT fall back when a user-configured default provider IS usable", async () => {
    const config = NexusConfig.parse({
      defaultProvider: "mock-flaky",
    });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    const res = resolveDefaultProvider(runtime, config.defaultProvider);
    expect(res).toEqual({ providerId: "mock-flaky", fellBack: false, requestedId: "mock-flaky" });
  });
});

/**
 * BUG: `nexus login anthropic` succeeds ("signed in to anthropic via oauth"),
 * but bare `nexus` still printed "Not logged in — using the offline 'mock'
 * provider" instead of dispatching through the just-authenticated Anthropic
 * account. Root cause: `isProviderUsable` never registered/credentialed
 * "anthropic" from an OAuth token alone — only from an API key, and only when
 * the user had also hand-added a `providers[]` config entry. These tests
 * reproduce the REAL run path (`buildAuthedRuntime`'s shape: `buildRuntime`
 * given an authRegistry) against the actual `@nexuscode/auth` stack — a real
 * `ProviderAuthRegistry` + `createAnthropicAuthStrategy` + `TokenStore` — with
 * an in-memory `SecretStore` standing in for the OS keychain/encrypted file (no
 * real keychain prompt, no network: the seeded token is far from expiry, so
 * `resolveCredential` never needs to refresh).
 */
describe("logged-in anthropic (OAuth token) is usable end-to-end — the real bug scenario", () => {
  it("isProviderUsable(anthropic) is TRUE and the default-run path picks anthropic — NOT mock", async () => {
    const secrets = createMemorySecretStore();

    // Simulate a completed `nexus login anthropic`: seed a valid, non-expired
    // TokenSet under the exact ref/shape the real OAuth strategy persists to.
    const tokenStore = createTokenStore(secrets);
    const fakeToken: TokenSet = {
      accessToken: "oat-fake-access-token",
      expiresAt: Date.now() + 3_600_000, // ~1h out — well outside the refresh skew
      scope: "user:inference",
      tokenType: "Bearer",
    };
    await tokenStore.set("anthropic", fakeToken);

    const authRegistry = new ProviderAuthRegistry();
    authRegistry.register(createAnthropicAuthStrategy({ secrets }));

    const config = NexusConfig.parse({}); // empty providers[] — the real first-run shape
    const runtime = await buildRuntime(config, { secrets, authRegistry });

    expect(runtime.registry.has("anthropic")).toBe(true);
    expect(isProviderUsable(runtime, "anthropic")).toBe(true);

    const resolution = resolveDefaultProvider(runtime, config.defaultProvider);
    expect(resolution).toEqual({ providerId: "anthropic", fellBack: false, requestedId: "anthropic" });

    // The adapter sends the OAuth Bearer, not an x-api-key: resolve through the
    // SAME strategy instance the adapter's `credential` source calls.
    const resolved = await authRegistry.get("anthropic")!.resolveCredential();
    expect(resolved.kind).toBe("bearer");
    expect(resolved.value).toBe("oat-fake-access-token");

    // And the adapter itself builds its client from that resolved credential —
    // no network (health() only constructs the SDK client).
    const adapter = runtime.registry.get("anthropic");
    const ac = new AbortController();
    const health = await adapter.health!({
      signal: ac.signal,
      idempotencyKey: "t",
      traceId: "t",
      runId: "t",
    });
    expect(health.ok).toBe(true);
  });

  it("with NO token and NO key, still falls back to mock — existing behavior preserved", async () => {
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const secrets = createMemorySecretStore();
      const authRegistry = new ProviderAuthRegistry();
      authRegistry.register(createAnthropicAuthStrategy({ secrets }));

      const config = NexusConfig.parse({});
      const runtime = await buildRuntime(config, { secrets, authRegistry });

      // anthropic IS now registered (the auth-aware default), but not usable.
      expect(runtime.registry.has("anthropic")).toBe(true);
      expect(isProviderUsable(runtime, "anthropic")).toBe(false);

      const resolution = resolveDefaultProvider(runtime, config.defaultProvider);
      expect(resolution).toEqual({ providerId: "mock", fellBack: true, requestedId: "anthropic" });
    } finally {
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });
});
