/**
 * Private model gateway tests (system-spec §25): a gateway rewrites a provider's
 * baseURL and injects required headers over BOTH config seams
 * (`baseUrl`/`headers` and `baseURL`/`defaultHeaders`); per-provider entries win
 * over a global default; a non-empty egress allowlist fails closed.
 */

import { describe, expect, it } from "vitest";
import {
  applyGateway,
  applyGatewaySet,
  resolveGateway,
  isEgressAllowed,
  hostOf,
  GatewayEgressError,
  type GatewayConfig,
  type GatewaySet,
} from "../src/gateway/index.js";

const GW: GatewayConfig = {
  baseUrl: "https://gw.corp.example.com/openai/v1",
  headers: { "x-org-id": "acme", authorization: "Bearer gw-token" },
};

describe("applyGateway — endpoint + header rewrite", () => {
  it("rewrites the adapter-config `baseURL` and merges `defaultHeaders`", () => {
    const providerCfg = {
      id: "openai",
      baseURL: "https://api.openai.com/v1",
      defaultHeaders: { "x-app": "nexuscode" },
    };
    const out = applyGateway(providerCfg, GW);

    expect(out.baseURL).toBe("https://gw.corp.example.com/openai/v1");
    // gateway headers injected; the provider's own static header preserved
    expect(out.defaultHeaders).toEqual({
      "x-app": "nexuscode",
      "x-org-id": "acme",
      authorization: "Bearer gw-token",
    });
    // input not mutated
    expect(providerCfg.baseURL).toBe("https://api.openai.com/v1");
    expect(providerCfg.defaultHeaders).toEqual({ "x-app": "nexuscode" });
  });

  it("rewrites the config-schema `baseUrl` and merges `headers`", () => {
    const providerCfg = {
      id: "grok",
      baseUrl: "https://api.x.ai/v1",
      headers: {} as Record<string, string>,
    };
    const out = applyGateway(providerCfg, GW);
    expect(out.baseUrl).toBe("https://gw.corp.example.com/openai/v1");
    expect(out.headers).toEqual({ "x-org-id": "acme", authorization: "Bearer gw-token" });
  });

  it("establishes `baseUrl`+`headers` when the config carries neither key", () => {
    const out = applyGateway({ id: "mock" }, GW);
    expect(out.baseUrl).toBe("https://gw.corp.example.com/openai/v1");
    expect(out.headers).toEqual({ "x-org-id": "acme", authorization: "Bearer gw-token" });
  });

  it("gateway headers win on a key clash by default; provider wins when override=false", () => {
    const cfg = { id: "openai", baseURL: "https://api.openai.com/v1", defaultHeaders: { "x-org-id": "provider-org" } };
    expect(applyGateway(cfg, GW).defaultHeaders?.["x-org-id"]).toBe("acme");
    const soft: GatewayConfig = { ...GW, overrideProviderHeaders: false };
    expect(applyGateway(cfg, soft).defaultHeaders?.["x-org-id"]).toBe("provider-org");
  });
});

describe("resolveGateway / applyGatewaySet — per-provider vs global", () => {
  const set: GatewaySet = {
    global: GW,
    byProvider: {
      anthropic: { baseUrl: "https://gw.corp.example.com/anthropic", headers: { "x-org-id": "acme" } },
    },
  };

  it("prefers a per-provider gateway over the global one", () => {
    expect(resolveGateway("anthropic", set)?.baseUrl).toBe("https://gw.corp.example.com/anthropic");
    expect(resolveGateway("openai", set)?.baseUrl).toBe(GW.baseUrl); // falls back to global
    expect(resolveGateway("ollama", { byProvider: {} })).toBeUndefined();
  });

  it("applyGatewaySet routes each provider through its resolved gateway", () => {
    const anthropic = applyGatewaySet({ id: "anthropic", baseURL: "https://api.anthropic.com" }, set);
    expect(anthropic.baseURL).toBe("https://gw.corp.example.com/anthropic");

    const openai = applyGatewaySet({ id: "openai", baseURL: "https://api.openai.com/v1" }, set);
    expect(openai.baseURL).toBe(GW.baseUrl);

    // no gateway governs → unchanged
    const none = applyGatewaySet({ id: "local", baseURL: "http://localhost:1234/v1" }, { byProvider: {} });
    expect(none.baseURL).toBe("http://localhost:1234/v1");
  });
});

describe("stripProviderAuth — the provider's own vendor credential is not forwarded to the gateway", () => {
  it("drops the provider's authorization/x-api-key headers by default", () => {
    const providerCfg = {
      id: "openai",
      baseURL: "https://api.openai.com/v1",
      defaultHeaders: {
        authorization: "Bearer sk-vendor-secret",
        "x-api-key": "sk-vendor-secret-2",
        "x-app": "nexuscode",
      },
    };
    const out = applyGateway(providerCfg, GW);
    // non-credential header preserved
    expect(out.defaultHeaders?.["x-app"]).toBe("nexuscode");
    // the gateway's OWN auth wins; the vendor's is gone, not merely overridden
    expect(out.defaultHeaders?.authorization).toBe("Bearer gw-token");
    expect(out.defaultHeaders?.["x-api-key"]).toBeUndefined();
    // input not mutated
    expect(providerCfg.defaultHeaders["x-api-key"]).toBe("sk-vendor-secret-2");
  });

  it("also strips when the gateway itself injects no clashing header", () => {
    const providerCfg = { id: "azure", baseURL: "https://my-resource.openai.azure.com", defaultHeaders: { "api-key": "sk-vendor-azure" } };
    const gw: GatewayConfig = { baseUrl: "https://gw.corp.example.com/azure", headers: { "x-org-id": "acme" } };
    const out = applyGateway(providerCfg, gw);
    expect(out.defaultHeaders?.["api-key"]).toBeUndefined();
    expect(out.defaultHeaders?.["x-org-id"]).toBe("acme");
  });

  it("keeps an explicitly allowlisted provider header", () => {
    const providerCfg = { id: "openai", baseURL: "https://api.openai.com/v1", defaultHeaders: { "x-api-key": "sk-vendor" } };
    const gw: GatewayConfig = { baseUrl: GW.baseUrl, headers: { "x-org-id": "acme" }, allowProviderHeaders: ["x-api-key"] };
    const out = applyGateway(providerCfg, gw);
    expect(out.defaultHeaders?.["x-api-key"]).toBe("sk-vendor");
  });

  it("stripProviderAuth: false preserves the legacy pass-through behavior", () => {
    const providerCfg = { id: "openai", baseURL: "https://api.openai.com/v1", defaultHeaders: { "x-api-key": "sk-vendor" } };
    const gw: GatewayConfig = { ...GW, stripProviderAuth: false };
    const out = applyGateway(providerCfg, gw);
    expect(out.defaultHeaders?.["x-api-key"]).toBe("sk-vendor");
  });
});

describe("egress allowlist — fail closed", () => {
  it("permits a gateway whose host is on the allowlist", () => {
    const gw: GatewayConfig = { ...GW, egressAllowlist: ["corp.example.com"] }; // dot-suffix match
    const out = applyGateway({ id: "openai", baseURL: "https://api.openai.com/v1" }, gw);
    expect(out.baseURL).toBe(GW.baseUrl);
  });

  it("throws GatewayEgressError when the gateway host is off the allowlist", () => {
    const gw: GatewayConfig = { ...GW, egressAllowlist: ["only-this.example.net"] };
    expect(() => applyGateway({ id: "openai", baseURL: "https://api.openai.com/v1" }, gw)).toThrow(
      GatewayEgressError,
    );
  });

  it("isEgressAllowed / hostOf building blocks", () => {
    expect(hostOf("https://gw.corp.example.com/x")).toBe("gw.corp.example.com");
    expect(hostOf("not a url")).toBeUndefined();
    expect(isEgressAllowed("https://gw.corp.example.com/x", ["corp.example.com"])).toBe(true);
    expect(isEgressAllowed("https://evil.example.org/x", ["corp.example.com"])).toBe(false);
    expect(isEgressAllowed("https://anything/x", [])).toBe(true); // empty allowlist = unrestricted
    expect(isEgressAllowed("garbage", ["corp.example.com"])).toBe(false); // unparseable + restricted = deny
  });
});
