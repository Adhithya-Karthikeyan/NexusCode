import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore, type SecretStore } from "@nexuscode/config";
import {
  createTokenStore,
  tokenRef,
  login,
  logout,
  redactTokenSet,
  redactTokensInText,
  refreshTokens,
  tokenSetFromBody,
  type OAuthProviderConfig,
  type TokenSet,
} from "@nexuscode/auth";
import { startMockOAuthServer, type MockOAuthServer } from "./mock-server.js";

function vaultStore() {
  const file = join(mkdtempSync(join(tmpdir(), "nx-auth-")), "secrets.enc.json");
  // Encrypted-file backend (no keychain) so tests never GUI-block. Per the
  // security rule: prefer a non-prompting store in headless contexts.
  return createSecretStore({ env: {}, disableKeychain: true, filePath: file, passphrase: "pw" });
}

function configFor(server: MockOAuthServer): OAuthProviderConfig {
  return {
    id: "mockprov",
    authorizeUrl: server.authorizeUrl,
    tokenEndpoint: server.tokenEndpoint,
    clientId: server.clientId,
    scopes: ["openid"],
    usesPkce: true,
  };
}

function browserSim(): (url: string) => Promise<boolean> {
  return async (url: string): Promise<boolean> => {
    const r = await fetch(url, { redirect: "manual" });
    const loc = r.headers.get("location");
    if (!loc) return false;
    await fetch(loc);
    return true;
  };
}

describe("TokenStore over SecretStore", () => {
  it("persists, reads back, and clears a TokenSet", async () => {
    const store = createTokenStore(vaultStore());
    const ts: TokenSet = {
      accessToken: "access-abc123",
      refreshToken: "refresh-xyz789",
      expiresAt: Date.now() + 3600_000,
      scope: "openid",
      tokenType: "Bearer",
    };
    await store.set("mockprov", ts);
    const got = await store.get("mockprov");
    expect(got).toEqual(ts);
    await store.clear("mockprov");
    expect(await store.get("mockprov")).toBeNull();
  });

  it("namespaces the SecretStore ref under oauth:<provider>", () => {
    expect(tokenRef("anthropic")).toBe("oauth:anthropic");
  });

  it("login runs the full PKCE flow and stores the tokens", async () => {
    const server = await startMockOAuthServer();
    const store = createTokenStore(vaultStore(), { fetchImpl: fetch });
    try {
      const tokens = await login({
        config: configFor(server),
        store,
        mode: "browser",
        openBrowser: browserSim(),
        fetchImpl: fetch,
        timeoutMs: 5000,
      });
      expect(tokens.accessToken).toMatch(/^access-/);
      const persisted = await store.get("mockprov");
      expect(persisted?.accessToken).toBe(tokens.accessToken);
      // logout clears it.
      await logout(store, "mockprov");
      expect(await store.get("mockprov")).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("getFresh auto-refreshes a token that is within the expiry skew", async () => {
    const server = await startMockOAuthServer({ rotateRefresh: true });
    const secrets = vaultStore();
    try {
      // Obtain a real refresh token via the mock, then store an ALREADY-EXPIRED set.
      const seed = await refreshViaAuthorize(server);
      const expired: TokenSet = { ...seed, expiresAt: Date.now() - 1000 };
      const store = createTokenStore(secrets, { fetchImpl: fetch });
      await store.set("mockprov", expired);

      const fresh = await store.getFresh("mockprov", configFor(server));
      expect(fresh).not.toBeNull();
      expect(fresh?.accessToken).not.toBe(expired.accessToken);
      expect(fresh?.expiresAt).toBeGreaterThan(Date.now());
      // The refreshed set was persisted.
      const reread = await store.get("mockprov");
      expect(reread?.accessToken).toBe(fresh?.accessToken);
    } finally {
      await server.close();
    }
  });

  it("getFresh deduplicates concurrent refreshes into a single in-flight request", async () => {
    const server = await startMockOAuthServer({ rotateRefresh: true });
    const secrets = vaultStore();
    try {
      // Seed an ALREADY-EXPIRED token set with a real (rotating) refresh token.
      const seed = await refreshViaAuthorize(server);
      const expired: TokenSet = { ...seed, expiresAt: Date.now() - 1000 };
      const store = createTokenStore(secrets, { fetchImpl: fetch });
      await store.set("mockprov", expired);

      // Two concurrent callers both see the expired token and race to refresh it.
      const [first, second] = await Promise.all([
        store.getFresh("mockprov", configFor(server)),
        store.getFresh("mockprov", configFor(server)),
      ]);

      // Only ONE refresh request should have hit the token endpoint — a second
      // request against a rotating server would consume the already-rotated
      // refresh token and fail (or persist a revoked-token-derived set).
      expect(server.refreshCount).toBe(1);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first?.accessToken).not.toBe(expired.accessToken);
      expect(first?.accessToken).toBe(second?.accessToken);
      expect(first?.refreshToken).toBe(second?.refreshToken);

      // The persisted set matches what both callers received.
      const persisted = await store.get("mockprov");
      expect(persisted?.accessToken).toBe(first?.accessToken);
    } finally {
      await server.close();
    }
  });

  it("getFresh re-reads latest before refreshing, closing the residual single-flight race", async () => {
    // Residual race (same store instance, same dedup map): caller A's own
    // `get` (the very first line of `getFresh`) reads the expired token and
    // suspends BEFORE it ever reaches the `refreshInFlight` map check. While
    // A is suspended, caller B runs an ENTIRE refresh on the same instance —
    // registers in the map, refreshes, persists, and (in its `finally`)
    // clears its own map entry — start to finish. When A resumes, the map
    // is empty again (B already cleared it), so A does NOT dedup against
    // B; it must instead re-read the store before refreshing, or it would
    // replay its stale (now-rotated, revoked) refresh token.
    //
    // Deterministic (no real-clock sleeps): a wrapped SecretStore gates only
    // the FIRST call to `get` and resolves it with a literal snapshot of the
    // seeded expired token — never touching the real backing store's timing
    // — so resolve order is fully controlled by `releaseGate()`, not by
    // racing file I/O against network I/O.
    const server = await startMockOAuthServer({ rotateRefresh: true });
    const secrets = vaultStore();
    try {
      const seed = await refreshViaAuthorize(server);
      const expired: TokenSet = { ...seed, expiresAt: Date.now() - 1000 };
      await secrets.set(tokenRef("mockprov"), JSON.stringify(expired));

      let getCalls = 0;
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      // Explicit delegation (not `{...secrets}`): `secrets` is a class
      // instance whose methods live on the prototype, so a spread would
      // silently drop `set`/`delete`/`source`.
      const gatedSecrets: SecretStore = {
        get: async (ref: string) => {
          getCalls += 1;
          if (getCalls === 1) {
            // Caller A's stale snapshot, captured deterministically (not
            // read from the real store, whose content will have changed by
            // the time this resolves) — then suspended until released.
            await gate;
            return JSON.stringify(expired);
          }
          return secrets.get(ref);
        },
        set: (ref, value) => secrets.set(ref, value),
        delete: (ref) => secrets.delete(ref),
        source: (ref) => secrets.source(ref),
      };
      const store = createTokenStore(gatedSecrets, { fetchImpl: fetch });

      // Caller A starts and suspends inside its first `get` (the gate) —
      // before it ever touches `refreshInFlight`.
      const aResult = store.getFresh("mockprov", configFor(server));

      // Caller B — same instance, same dedup map — runs a full refresh to
      // completion (register, refresh, persist, clear its dedup slot)
      // while A is still suspended.
      const bResult = await store.getFresh("mockprov", configFor(server));
      expect(server.refreshCount).toBe(1);

      // Release A: it resumes with the stale (pre-B) token it captured, the
      // map is already empty (B cleared it), so A does not dedup against B
      // — it must re-read before refreshing and see B's already-fresh
      // result instead of replaying B's now-rotated refresh token.
      releaseGate();
      const resolvedA = await aResult;

      expect(server.refreshCount).toBe(1); // no second network refresh from A
      expect(resolvedA?.accessToken).toBe(bResult?.accessToken);
      expect(resolvedA?.refreshToken).toBe(bResult?.refreshToken);
    } finally {
      await server.close();
    }
  });

  it("getFresh returns a still-valid token unchanged", async () => {
    const store = createTokenStore(vaultStore(), { fetchImpl: fetch });
    const server = await startMockOAuthServer();
    try {
      const ts: TokenSet = {
        accessToken: "access-keepme",
        refreshToken: "refresh-keepme",
        expiresAt: Date.now() + 3600_000,
        scope: "openid",
        tokenType: "Bearer",
      };
      await store.set("mockprov", ts);
      const same = await store.getFresh("mockprov", configFor(server));
      expect(same?.accessToken).toBe("access-keepme");
    } finally {
      await server.close();
    }
  });

  it("getFresh throws when expired and not refreshable", async () => {
    const store = createTokenStore(vaultStore(), { fetchImpl: fetch });
    const server = await startMockOAuthServer();
    try {
      const ts: TokenSet = {
        accessToken: "access-dead",
        expiresAt: Date.now() - 1000,
        scope: "openid",
        tokenType: "Bearer",
      };
      await store.set("mockprov", ts);
      await expect(store.getFresh("mockprov", configFor(server))).rejects.toMatchObject({
        code: "invalid_grant",
      });
    } finally {
      await server.close();
    }
  });

  it("refreshTokens carries the old refresh token forward when none is returned", async () => {
    const server = await startMockOAuthServer({ rotateRefresh: false });
    try {
      const seed = await refreshViaAuthorize(server);
      const refreshed = await refreshTokens(configFor(server), seed.refreshToken as string, {
        fetchImpl: fetch,
      });
      expect(refreshed.refreshToken).toBe(seed.refreshToken);
      expect(refreshed.accessToken).not.toBe(seed.accessToken);
    } finally {
      await server.close();
    }
  });
});

describe("redaction — tokens never reach a log", () => {
  it("redactTokenSet masks access + refresh tokens", () => {
    const ts: TokenSet = {
      accessToken: "access-supersecretvalue1234",
      refreshToken: "refresh-anothersecret5678",
      expiresAt: 123,
      scope: "openid",
      tokenType: "Bearer",
    };
    const red = redactTokenSet(ts);
    const serialized = JSON.stringify(red);
    expect(serialized).not.toContain("access-supersecretvalue1234");
    expect(serialized).not.toContain("refresh-anothersecret5678");
    expect(red.accessToken).toContain("1234");
    expect(red.scope).toBe("openid");
  });

  it("redactTokensInText scrubs token substrings from arbitrary text", () => {
    const ts: TokenSet = {
      accessToken: "access-leakme-abcdef",
      refreshToken: "refresh-leakme-ghijkl",
      expiresAt: 0,
      scope: "s",
      tokenType: "Bearer",
    };
    const line = `bearer=${ts.accessToken}; refresh=${ts.refreshToken}`;
    const scrubbed = redactTokensInText(line, ts);
    expect(scrubbed).not.toContain("access-leakme-abcdef");
    expect(scrubbed).not.toContain("refresh-leakme-ghijkl");
  });
});

/** Helper: drive a full authorize+exchange against the mock to get a real TokenSet. */
async function refreshViaAuthorize(server: MockOAuthServer): Promise<TokenSet> {
  const cfg = configFor(server);
  // Hit /authorize (no PKCE challenge needed for this seed path since we drive
  // the code exchange directly) and follow the redirect to read the code.
  const authUrl = new URL(cfg.authorizeUrl);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", cfg.clientId);
  authUrl.searchParams.set("redirect_uri", "http://127.0.0.1:1/callback");
  authUrl.searchParams.set("scope", cfg.scopes.join(" "));
  authUrl.searchParams.set("state", "seed");
  const r = await fetch(authUrl.toString(), { redirect: "manual" });
  const loc = new URL(r.headers.get("location") as string);
  const code = loc.searchParams.get("code") as string;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: "http://127.0.0.1:1/callback",
    client_id: cfg.clientId,
  }).toString();
  const tr = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return tokenSetFromBody(JSON.parse(await tr.text()), Date.now(), cfg.scopes.join(" "));
}
