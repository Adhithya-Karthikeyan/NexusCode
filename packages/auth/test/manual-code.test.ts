/**
 * The manual-code-paste flow (`flows/manual-code.ts`) — EXACTLY what Claude
 * Code's own CLI does for Anthropic: build the authorize URL with a FIXED,
 * non-loopback `redirect_uri` + `code=true` (never a `127.0.0.1` loopback,
 * which Anthropic's authorize endpoint rejects with "Invalid request format"),
 * then split/verify a pasted `code#state` string and exchange it via a JSON
 * (not form-encoded) POST to the token endpoint.
 */
import { describe, it, expect } from "vitest";
import {
  runManualCodeFlow,
  splitPastedCode,
  buildAuthorizeUrl,
  ANTHROPIC_OAUTH_CONFIG,
  isOAuthError,
  type FetchLike,
  type OAuthProviderConfig,
} from "@nexuscode/auth";

// ── the real Anthropic authorize URL shape ──────────────────────────────────

describe("Anthropic authorize URL (manual-code paste — login like Claude Code)", () => {
  it("carries EXACTLY the query params Claude Code's own CLI sends — no loopback redirect", () => {
    const url = buildAuthorizeUrl(ANTHROPIC_OAUTH_CONFIG, {
      redirectUri: ANTHROPIC_OAUTH_CONFIG.redirectUri as string,
      state: "test-state-value",
      codeChallenge: "test-challenge-value",
    });
    const u = new URL(url);
    // The Claude.ai SUBSCRIPTION authorize endpoint — NOT the Console/API one
    // (`platform.claude.com/oauth/authorize`), which yields a token that can't
    // read subscription data. Verified against ClaudeGauge's OAuthService.swift.
    expect(u.origin + u.pathname).toBe("https://claude.com/cai/oauth/authorize");
    expect(u.searchParams.get("code")).toBe("true");
    expect(u.searchParams.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("redirect_uri")).toBe(
      "https://platform.claude.com/oauth/code/callback",
    );
    expect(u.searchParams.get("scope")).toBe(
      "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
    );
    expect(u.searchParams.get("code_challenge")).toBe("test-challenge-value");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe("test-state-value");
    // The one thing this MUST NOT be: a loopback redirect.
    expect(u.searchParams.get("redirect_uri")).not.toMatch(/127\.0\.0\.1|localhost/);
  });

  it("ANTHROPIC_OAUTH_CONFIG is wired for the manual-code flow", () => {
    expect(ANTHROPIC_OAUTH_CONFIG.manualCode).toBe(true);
    expect(ANTHROPIC_OAUTH_CONFIG.redirectUri).toBe(
      "https://platform.claude.com/oauth/code/callback",
    );
    expect(ANTHROPIC_OAUTH_CONFIG.extraAuthorizeParams).toEqual({ code: "true" });
  });
});

// ── splitPastedCode ──────────────────────────────────────────────────────────

describe("splitPastedCode", () => {
  it("splits a pasted `code#state` string on the first '#'", () => {
    expect(splitPastedCode("abc123#XYZstate")).toEqual({ code: "abc123", state: "XYZstate" });
  });

  it("trims surrounding whitespace/newlines", () => {
    expect(splitPastedCode("  abc123#XYZstate  \n")).toEqual({ code: "abc123", state: "XYZstate" });
  });

  it("treats a missing '#' as a code with empty state", () => {
    expect(splitPastedCode("abc123")).toEqual({ code: "abc123", state: "" });
  });

  it("treats an empty string as an empty code and state", () => {
    expect(splitPastedCode("")).toEqual({ code: "", state: "" });
  });
});

// ── runManualCodeFlow ────────────────────────────────────────────────────────

function fakeConfig(): OAuthProviderConfig {
  return {
    id: "mockprov",
    authorizeUrl: "https://as.example/authorize",
    tokenEndpoint: "https://as.example/token",
    clientId: "test-client-id",
    scopes: ["a", "b"],
    usesPkce: true,
    redirectUri: "https://example.com/oauth/code/callback",
    manualCode: true,
    extraAuthorizeParams: { code: "true" },
  };
}

interface CapturedRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

describe("runManualCodeFlow", () => {
  it("splits the pasted code#state, verifies state, and POSTs the exact JSON body to the token endpoint", async () => {
    let captured: CapturedRequest | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url: String(url), ...init };
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "access-abc",
            refresh_token: "refresh-abc",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "a b",
          }),
      };
    };

    let seenState = "";
    const urls: string[] = [];
    const tokens = await runManualCodeFlow({
      config: fakeConfig(),
      fetchImpl,
      onAuthorizeUrl: (u) => {
        urls.push(u);
        seenState = new URL(u).searchParams.get("state") ?? "";
      },
      readCode: async () => `abc123#${seenState}`,
    });

    expect(urls).toHaveLength(1);
    expect(tokens.accessToken).toBe("access-abc");
    expect(tokens.refreshToken).toBe("refresh-abc");
    expect(tokens.scope).toBe("a b");

    expect(captured).toBeDefined();
    expect(captured?.url).toBe("https://as.example/token");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers?.["content-type"]).toBe("application/json");
    const body = JSON.parse(captured?.body ?? "{}") as Record<string, unknown>;
    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("abc123");
    expect(body.state).toBe(seenState);
    expect(body.client_id).toBe("test-client-id");
    expect(body.redirect_uri).toBe("https://example.com/oauth/code/callback");
    expect(typeof body.code_verifier).toBe("string");
    expect((body.code_verifier as string).length).toBeGreaterThan(0);
  });

  it("rejects a wrong pasted state and never calls the token endpoint", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const err = await runManualCodeFlow({
      config: fakeConfig(),
      fetchImpl,
      readCode: async () => "abc123#totally-wrong-state",
    }).catch((e) => e);
    expect(isOAuthError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("state_mismatch");
    expect(called).toBe(false);
  });

  it("rejects an empty pasted code (e.g. EOF with nothing entered) with a clean error", async () => {
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return { ok: true, status: 200, text: async () => "{}" };
    };
    const err = await runManualCodeFlow({
      config: fakeConfig(),
      fetchImpl,
      readCode: async () => "",
    }).catch((e) => e);
    expect(isOAuthError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("missing_code");
    expect(called).toBe(false);
  });

  it("proceeds even when the best-effort openBrowser throws", async () => {
    let seenState = "";
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          access_token: "access-x",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "a b",
        }),
    });
    const tokens = await runManualCodeFlow({
      config: fakeConfig(),
      fetchImpl,
      onAuthorizeUrl: (u) => {
        seenState = new URL(u).searchParams.get("state") ?? "";
      },
      openBrowser: async () => {
        throw new Error("no display available");
      },
      readCode: async () => `abc123#${seenState}`,
    });
    expect(tokens.accessToken).toBe("access-x");
  });

  it("throws a clear config error when the provider has no fixed redirectUri", async () => {
    const { redirectUri: _redirectUri, ...withoutRedirect } = fakeConfig();
    void _redirectUri;
    const err = await runManualCodeFlow({
      config: withoutRedirect,
      readCode: async () => "abc123#state",
    }).catch((e) => e);
    expect(isOAuthError(err)).toBe(true);
    expect((err as { code: string }).code).toBe("invalid_config");
  });
});
