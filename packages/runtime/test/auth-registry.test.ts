/**
 * Wave 13: when an auth registry is passed to `buildRuntime`, a configured
 * provider with an OAuth strategy (Anthropic "login like Claude Code") resolves
 * its credential THROUGH the registry — the adapter receives an auto-refreshed
 * Bearer token instead of the legacy api-key path. Fully offline: the registry
 * is a fake and only the credential-resolution wiring is exercised (no network,
 * no real Anthropic client request).
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

const anthropicConfig = NexusConfig.parse({
  providers: [
    {
      id: "anthropic",
      kind: "anthropic",
      adapter: "@nexuscode/provider-anthropic",
      modelMap: { claude: "claude-3-5-sonnet-latest" },
    },
  ],
});

describe("runtime auth-registry wiring", () => {
  it("resolves the Anthropic credential through the registry (Bearer) on first client use", async () => {
    const resolveCredential = vi.fn(async () => ({ kind: "bearer" as const, value: "oat-live-token" }));
    const authRegistry: AuthRegistryLike = {
      get: (id) => (id === "anthropic" ? { resolveCredential } : undefined),
    };

    const runtime = await buildRuntime(anthropicConfig, { secrets: stubSecrets, authRegistry });
    expect(runtime.registry.has("anthropic")).toBe(true);

    // The Anthropic adapter's credential was resolved THROUGH the registry — the
    // health probe at registration builds the client from the registry's Bearer
    // token (proving the wiring), not the legacy api-key `cred` path.
    expect(resolveCredential).toHaveBeenCalled();

    // And a subsequent real use continues to resolve via the same registry.
    const adapter = runtime.registry.get("anthropic");
    const ac = new AbortController();
    const status = await adapter.health!({
      signal: ac.signal,
      idempotencyKey: "t",
      traceId: "t",
      runId: "t",
    });
    expect(status.ok).toBe(true);
  });

  it("without a registry, the legacy api-key path is used unchanged (no crash)", async () => {
    const runtime = await buildRuntime(anthropicConfig, { secrets: stubSecrets });
    expect(runtime.registry.has("anthropic")).toBe(true);
  });
});
