import { describe, it, expect } from "vitest";
import {
  runDeviceCodeFlow,
  requestDeviceAuthorization,
  defaultFetch,
  type OAuthProviderConfig,
  type DeviceAuthorization,
} from "@nexuscode/auth";
import { startMockOAuthServer, type MockOAuthServer } from "./mock-server.js";

function configFor(server: MockOAuthServer): OAuthProviderConfig {
  return {
    id: "mockprov",
    authorizeUrl: server.authorizeUrl,
    tokenEndpoint: server.tokenEndpoint,
    deviceEndpoint: server.deviceEndpoint,
    clientId: server.clientId,
    scopes: ["offline_access"],
    usesPkce: true,
  };
}

const noWait = (): Promise<void> => Promise.resolve();

describe("Device Authorization Grant (headless fallback)", () => {
  it("requests device+user codes and a verification URI", async () => {
    const server = await startMockOAuthServer();
    try {
      const auth = await requestDeviceAuthorization(configFor(server), fetch);
      expect(auth.deviceCode).toMatch(/^device-/);
      expect(auth.userCode.length).toBeGreaterThan(0);
      expect(auth.verificationUri).toContain("/device");
      expect(auth.interval).toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
    }
  });

  it("polls to success after authorization_pending", async () => {
    const server = await startMockOAuthServer({ devicePendingPolls: 2 });
    try {
      let prompted: DeviceAuthorization | null = null;
      const tokens = await runDeviceCodeFlow({
        config: configFor(server),
        onPrompt: (a) => (prompted = a),
        fetchImpl: fetch,
        sleep: noWait,
      });
      expect(prompted).not.toBeNull();
      expect(tokens.accessToken).toMatch(/^access-/);
      expect(tokens.scope).toBe("offline_access");
    } finally {
      await server.close();
    }
  });

  it("backs off on slow_down and still succeeds", async () => {
    const server = await startMockOAuthServer({ devicePendingPolls: 1, deviceSlowDownOnce: true });
    try {
      const tokens = await runDeviceCodeFlow({
        config: configFor(server),
        fetchImpl: fetch,
        sleep: noWait,
      });
      expect(tokens.accessToken).toMatch(/^access-/);
    } finally {
      await server.close();
    }
  });

  it("rejects when the config has no device endpoint", async () => {
    const cfg: OAuthProviderConfig = {
      id: "nodev",
      authorizeUrl: "https://as.example/authorize",
      tokenEndpoint: "https://as.example/token",
      clientId: "cid",
      scopes: ["s"],
      usesPkce: true,
    };
    await expect(
      runDeviceCodeFlow({ config: cfg, fetchImpl: fetch, sleep: noWait }),
    ).rejects.toMatchObject({ code: "no_device_endpoint" });
  });

  it("honors an abort signal during polling", async () => {
    const server = await startMockOAuthServer({ devicePendingPolls: 100 });
    const ac = new AbortController();
    try {
      const p = runDeviceCodeFlow({
        config: configFor(server),
        fetchImpl: fetch,
        sleep: async () => {
          ac.abort();
        },
        signal: ac.signal,
      });
      await expect(p).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      await server.close();
    }
  });

  it("defaultFetch resolves the global fetch", () => {
    expect(typeof defaultFetch()).toBe("function");
  });
});
