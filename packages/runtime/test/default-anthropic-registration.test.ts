/**
 * BUG FIX: `nexus login anthropic` only ever writes a token through the auth
 * registry's SecretStore — it never adds a `providers[]` config entry. Since
 * `providers[]` defaults to EMPTY, "anthropic" was never registered as an
 * adapter at all on a fresh install, so `isProviderUsable` returned false
 * before it ever looked at a credential and the default run path fell back to
 * the offline mock provider despite a successful OAuth login.
 *
 * `registerDefaultAnthropicProvider` (src/index.ts) closes this gap: when the
 * caller supplies an `authRegistry`, "anthropic" is registered by default (like
 * the other zero-config cloud providers) with `needsKey` reflecting whichever
 * credential — a stored OAuth bearer token, or a console API key — is
 * ACTUALLY resolvable right now. These tests exercise that registration path
 * directly and fully offline (a fake `AuthRegistryLike`, no network, no real
 * keychain).
 */
import { describe, it, expect, vi } from "vitest";
import { NexusConfig, type SecretStore } from "@nexuscode/config";
import { buildRuntime, type AuthRegistryLike } from "../src/index.js";

const stubSecrets: SecretStore = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  source: async () => null,
};

describe("registerDefaultAnthropicProvider — authRegistry-gated default registration", () => {
  it("without an authRegistry, anthropic stays unregistered (pre-existing behavior unchanged)", async () => {
    const config = NexusConfig.parse({});
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    expect(runtime.registry.has("anthropic")).toBe(false);
  });

  it("with an authRegistry but no login/key, anthropic registers but needsKey stays true", async () => {
    const config = NexusConfig.parse({});
    const authRegistry: AuthRegistryLike = {
      get: (id) =>
        id === "anthropic"
          ? { resolveCredential: async () => ({ kind: "none" as const, value: "" }) }
          : undefined,
    };
    const runtime = await buildRuntime(config, { secrets: stubSecrets, authRegistry });

    expect(runtime.registry.has("anthropic")).toBe(true);
    const status = runtime.statuses.find((s) => s.id === "anthropic");
    expect(status?.available).toBe(true);
    expect(status?.needsKey).toBe(true);
  });

  it("with a logged-in (bearer) auth strategy, anthropic registers usable — needsKey false", async () => {
    const config = NexusConfig.parse({});
    const resolveCredential = vi.fn(async () => ({ kind: "bearer" as const, value: "oat-fake-token" }));
    const authRegistry: AuthRegistryLike = {
      get: (id) => (id === "anthropic" ? { resolveCredential } : undefined),
    };
    const runtime = await buildRuntime(config, { secrets: stubSecrets, authRegistry });

    expect(runtime.registry.has("anthropic")).toBe(true);
    const status = runtime.statuses.find((s) => s.id === "anthropic");
    expect(status?.available).toBe(true);
    expect(status?.needsKey).toBe(false);
    expect(resolveCredential).toHaveBeenCalled();

    // The adapter itself resolves the SAME bearer credential on use — no
    // network (health() only builds the SDK client, never calls out).
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

  it("does not override (or duplicate-register) an explicit user-configured anthropic entry", async () => {
    const config = NexusConfig.parse({
      providers: [
        {
          id: "anthropic",
          kind: "anthropic",
          adapter: "@nexuscode/provider-anthropic",
          modelMap: { claude: "claude-3-5-sonnet-latest" },
        },
      ],
    });
    const authRegistry: AuthRegistryLike = {
      get: () => ({ resolveCredential: async () => ({ kind: "bearer" as const, value: "unused" }) }),
    };
    const runtime = await buildRuntime(config, { secrets: stubSecrets, authRegistry });

    // Exactly one "anthropic" registration — the user's own entry wins, and
    // registerDefaultAnthropicProvider's `registry.has()` guard skips it
    // (a second `registry.register()` call for the same id would throw).
    expect(runtime.statuses.filter((s) => s.id === "anthropic")).toHaveLength(1);
    expect(runtime.registry.has("anthropic")).toBe(true);
  });
});
