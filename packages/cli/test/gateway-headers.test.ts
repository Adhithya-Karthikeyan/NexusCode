/**
 * Offline test for the private-gateway header wiring (system-spec §25). A
 * corporate gateway must both (a) override the provider's `baseURL` AND (b)
 * inject its signed org token / `x-org-id` headers. This drives `buildRuntime`
 * with a configured openai-compat provider governed by a gateway and asserts the
 * adapter factory receives BOTH the rewritten baseURL and the merged headers —
 * proving the gateway auth token is not dropped on the way to the adapter.
 *
 * `@nexuscode/provider-openai` is partially mocked: the real factory still runs
 * (so registration/capabilities behave normally), but the config it is called
 * with is captured for inspection. No network is ever touched.
 */

import { describe, it, expect, vi } from "vitest";
import { NexusConfig, type SecretStore } from "@nexuscode/config";
import type { GatewaySet } from "@nexuscode/enterprise";
import { buildRuntime } from "../src/runtime.js";

// Hoisted holder so the (hoisted) vi.mock factory and the test body share state.
const captured = vi.hoisted(() => ({ cfg: undefined as Record<string, unknown> | undefined }));

vi.mock("@nexuscode/provider-openai", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const realFactory = actual["createOpenAICompatAdapter"] as (cfg: Record<string, unknown>) => unknown;
  return {
    ...actual,
    createOpenAICompatAdapter: (cfg: Record<string, unknown>) => {
      if (cfg?.id === "corp-openai") captured.cfg = cfg;
      return realFactory(cfg);
    },
  };
});

const stubSecrets: SecretStore = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  source: async () => null,
};

describe("private-gateway header wiring (§25)", () => {
  it("threads the gateway baseURL AND injected headers to the openai-compat adapter", async () => {
    captured.cfg = undefined;
    const config = NexusConfig.parse({
      providers: [
        {
          id: "corp-openai",
          kind: "openai-compat",
          adapter: "@nexuscode/provider-openai",
          baseUrl: "https://api.openai.com/v1",
          models: ["gpt-4o"],
        },
      ],
    });
    const gateways: GatewaySet = {
      byProvider: {
        "corp-openai": {
          baseUrl: "https://gw.corp.example.com/v1",
          headers: { "x-org-id": "acme", authorization: "Bearer gw-signed-token" },
        },
      },
    };

    const runtime = await buildRuntime(config, { secrets: stubSecrets, gateways });
    try {
      expect(runtime.registry.has("corp-openai")).toBe(true);
      expect(captured.cfg, "the adapter factory was invoked for the gateway provider").toBeDefined();
      // (a) endpoint override reaches the adapter.
      expect(captured.cfg!.baseURL).toBe("https://gw.corp.example.com/v1");
      // (b) the signed org token / x-org-id headers are NOT dropped.
      expect(captured.cfg!.defaultHeaders).toEqual({
        "x-org-id": "acme",
        authorization: "Bearer gw-signed-token",
      });
    } finally {
      await runtime.registry.disposeAll();
    }
  });

  it("without a gateway, no defaultHeaders are injected (unchanged behavior)", async () => {
    captured.cfg = undefined;
    const config = NexusConfig.parse({
      providers: [
        {
          id: "corp-openai",
          kind: "openai-compat",
          adapter: "@nexuscode/provider-openai",
          baseUrl: "https://api.openai.com/v1",
          models: ["gpt-4o"],
        },
      ],
    });

    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    try {
      expect(captured.cfg).toBeDefined();
      expect(captured.cfg!.baseURL).toBe("https://api.openai.com/v1");
      expect(captured.cfg!.defaultHeaders).toBeUndefined();
    } finally {
      await runtime.registry.disposeAll();
    }
  });
});
