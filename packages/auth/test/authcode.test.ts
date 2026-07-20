import { describe, it, expect } from "vitest";
import {
  runAuthorizationCodeFlow,
  buildAuthorizeUrl,
  isOAuthError,
  type OAuthProviderConfig,
} from "@nexuscode/auth";
import { startMockOAuthServer, type MockOAuthServer } from "./mock-server.js";

function configFor(server: MockOAuthServer): OAuthProviderConfig {
  return {
    id: "mockprov",
    authorizeUrl: server.authorizeUrl,
    tokenEndpoint: server.tokenEndpoint,
    clientId: server.clientId,
    scopes: ["openid", "profile"],
    usesPkce: true,
  };
}

/**
 * Simulate the browser: GET the authorize URL, read the mock AS's 302 Location
 * (the loopback redirect), optionally tamper it, then hit the loopback callback.
 */
function browserSim(tamper?: (loc: URL) => void): (url: string) => Promise<boolean> {
  return async (url: string): Promise<boolean> => {
    const r = await fetch(url, { redirect: "manual" });
    const loc = r.headers.get("location");
    if (!loc) return false;
    const target = new URL(loc);
    if (tamper) tamper(target);
    await fetch(target.toString());
    return true;
  };
}

describe("Authorization Code + PKCE loopback flow", () => {
  it("completes end-to-end: server started, code captured, tokens exchanged", async () => {
    const server = await startMockOAuthServer();
    try {
      const urls: string[] = [];
      const tokens = await runAuthorizationCodeFlow({
        config: configFor(server),
        openBrowser: browserSim(),
        onAuthorizeUrl: (u) => urls.push(u),
        fetchImpl: fetch,
        timeoutMs: 5000,
      });
      expect(tokens.accessToken).toMatch(/^access-/);
      expect(tokens.refreshToken).toMatch(/^refresh-/);
      expect(tokens.tokenType).toBe("Bearer");
      expect(tokens.scope).toBe("openid profile");
      expect(tokens.expiresAt).toBeGreaterThan(Date.now());
      // The authorize URL carried PKCE + state + the loopback redirect.
      expect(urls).toHaveLength(1);
      const au = new URL(urls[0] as string);
      expect(au.searchParams.get("code_challenge_method")).toBe("S256");
      expect(au.searchParams.get("code_challenge")).toBeTruthy();
      expect(au.searchParams.get("state")).toBeTruthy();
      expect(au.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    } finally {
      await server.close();
    }
  });

  it("ignores a state-mismatched callback (CSRF protection) and times out without a genuine follow-up", async () => {
    const server = await startMockOAuthServer();
    try {
      let tamperedStatus: number | undefined;
      await expect(
        runAuthorizationCodeFlow({
          config: configFor(server),
          openBrowser: async (url: string): Promise<boolean> => {
            const r = await fetch(url, { redirect: "manual" });
            const loc = new URL(r.headers.get("location") as string);
            loc.searchParams.set("state", "tampered");
            const cbRes = await fetch(loc.toString());
            tamperedStatus = cbRes.status;
            return true;
          },
          fetchImpl: fetch,
          // Short timeout: no genuine callback ever arrives after the
          // tampered one, so the flow must time out rather than resolve.
          timeoutMs: 200,
        }),
      ).rejects.toMatchObject({ code: "timeout" });
      // The tampered request itself was rejected...
      expect(tamperedStatus).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("does not let a bogus/mismatched callback abort the flow — the genuine callback still completes it", async () => {
    const server = await startMockOAuthServer();
    try {
      const tokens = await runAuthorizationCodeFlow({
        config: configFor(server),
        openBrowser: async (url: string): Promise<boolean> => {
          const r = await fetch(url, { redirect: "manual" });
          const loc = new URL(r.headers.get("location") as string);

          // A stray/attacker request hits the ephemeral loopback port with a
          // wrong `state` BEFORE the genuine redirect arrives. It must be
          // rejected on its own but must NOT tear down the in-progress login.
          const bogus = new URL(loc.origin + loc.pathname);
          bogus.searchParams.set("state", "wrong");
          const bogusRes = await fetch(bogus.toString());
          expect(bogusRes.status).toBe(400);

          // The genuine callback arrives afterward and must still complete
          // the flow.
          await fetch(loc.toString());
          return true;
        },
        fetchImpl: fetch,
        timeoutMs: 5000,
      });
      expect(tokens.accessToken).toMatch(/^access-/);
    } finally {
      await server.close();
    }
  });

  it("surfaces a provider error returned to the redirect", async () => {
    const server = await startMockOAuthServer();
    try {
      const err = await runAuthorizationCodeFlow({
        config: configFor(server),
        openBrowser: async (url: string): Promise<boolean> => {
          const r = await fetch(url, { redirect: "manual" });
          const loc = new URL(r.headers.get("location") as string);
          // Replace the successful code with an error redirect.
          const cb = new URL(loc.origin + loc.pathname);
          cb.searchParams.set("error", "access_denied");
          cb.searchParams.set("state", loc.searchParams.get("state") ?? "");
          await fetch(cb.toString());
          return true;
        },
        fetchImpl: fetch,
        timeoutMs: 5000,
      }).catch((e) => e);
      expect(isOAuthError(err)).toBe(true);
      expect(err.code).toBe("access_denied");
    } finally {
      await server.close();
    }
  });

  it("does not reflect a provider-supplied error string into the callback HTML (XSS)", async () => {
    const server = await startMockOAuthServer();
    try {
      const payload = "<script>window.__xss=1</script>";
      let bodyText = "";
      const err = await runAuthorizationCodeFlow({
        config: configFor(server),
        openBrowser: async (url: string): Promise<boolean> => {
          const r = await fetch(url, { redirect: "manual" });
          const loc = new URL(r.headers.get("location") as string);
          const cb = new URL(loc.origin + loc.pathname);
          cb.searchParams.set("state", loc.searchParams.get("state") ?? "");
          cb.searchParams.set("error", payload);
          const cbRes = await fetch(cb.toString());
          bodyText = await cbRes.text();
          return true;
        },
        fetchImpl: fetch,
        timeoutMs: 5000,
      }).catch((e) => e);
      expect(isOAuthError(err)).toBe(true);
      // The raw error string never appears in the HTML the loopback server
      // serves — it only travels out-of-band via the thrown OAuthError.
      expect(bodyText).not.toContain("<script>");
      expect(bodyText).not.toContain(payload);
    } finally {
      await server.close();
    }
  });

  it("times out when no redirect arrives", async () => {
    const server = await startMockOAuthServer();
    try {
      await expect(
        runAuthorizationCodeFlow({
          config: configFor(server),
          openBrowser: async () => true, // never hits the callback
          fetchImpl: fetch,
          timeoutMs: 150,
        }),
      ).rejects.toMatchObject({ code: "timeout" });
    } finally {
      await server.close();
    }
  });

  it("honors an external abort signal", async () => {
    const server = await startMockOAuthServer();
    const ac = new AbortController();
    try {
      const p = runAuthorizationCodeFlow({
        config: configFor(server),
        openBrowser: async () => true,
        fetchImpl: fetch,
        timeoutMs: 5000,
        signal: ac.signal,
      });
      ac.abort();
      await expect(p).rejects.toMatchObject({ code: "cancelled" });
    } finally {
      await server.close();
    }
  });

  it("buildAuthorizeUrl omits PKCE params when usesPkce is false", () => {
    const url = buildAuthorizeUrl(
      {
        id: "x",
        authorizeUrl: "https://as.example/authorize",
        tokenEndpoint: "https://as.example/token",
        clientId: "cid",
        scopes: ["a", "b"],
        usesPkce: false,
      },
      { redirectUri: "http://127.0.0.1:1234/callback", state: "st" },
    );
    const u = new URL(url);
    expect(u.searchParams.get("code_challenge")).toBeNull();
    expect(u.searchParams.get("scope")).toBe("a b");
    expect(u.searchParams.get("state")).toBe("st");
  });
});
