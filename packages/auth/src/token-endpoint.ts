/**
 * The shared token-endpoint HTTP layer: a single `application/x-www-form-urlencoded`
 * POST used by all three grant paths (authorization_code exchange, refresh_token,
 * and device_code polling). The raw variant returns the parsed body even on a
 * non-2xx response so the device flow can read `authorization_pending`/`slow_down`
 * without treating them as hard failures; the typed helpers turn a non-OK body
 * into an {@link OAuthError}.
 *
 * `postJson`/`exchangeAuthorizationCodeManual` are the ONE exception to the
 * form-encoded rule: Anthropic's manual-code-paste token endpoint (the same one
 * Claude Code's CLI uses) expects a JSON request body instead — see
 * `flows/manual-code.ts`.
 */

import { OAuthError } from "./error.js";
import { tokenSetFromBody } from "./tokenset.js";
import type { FetchLike, OAuthProviderConfig, TokenResponseBody, TokenSet } from "./types.js";

/** Resolve the default `fetch` as our structural {@link FetchLike}. */
export function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== "function") {
    throw new OAuthError("network_error", "global fetch is unavailable in this runtime");
  }
  return f as unknown as FetchLike;
}

export interface RawTokenResult {
  ok: boolean;
  status: number;
  body: TokenResponseBody;
}

/**
 * POST form params to a URL and parse the JSON body, returning it regardless of
 * HTTP status. Network/parse failures raise a `network_error` `OAuthError`.
 */
export async function postForm(
  url: string,
  params: Record<string, string>,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<RawTokenResult> {
  const body = new URLSearchParams(params).toString();
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (e instanceof OAuthError) throw e;
    throw new OAuthError("network_error", `request to token endpoint failed`, String(e));
  }
  const text = await res.text();
  let parsed: TokenResponseBody = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as TokenResponseBody;
    } catch {
      parsed = {};
    }
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/**
 * POST a JSON body and parse the JSON response, returning it regardless of HTTP
 * status (mirrors {@link postForm}'s contract). Used by the manual-code-paste
 * exchange, whose token endpoint expects `application/json` rather than
 * form-encoded params.
 */
export async function postJson(
  url: string,
  body: Record<string, unknown>,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<RawTokenResult> {
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (e instanceof OAuthError) throw e;
    throw new OAuthError("network_error", `request to token endpoint failed`, String(e));
  }
  const text = await res.text();
  let parsed: TokenResponseBody = {};
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text) as TokenResponseBody;
    } catch {
      parsed = {};
    }
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

/** Raise the appropriate `OAuthError` for a non-OK token-endpoint result. */
function throwForBody(res: RawTokenResult): never {
  const code = res.body.error ?? "token_endpoint_error";
  const desc = res.body.error_description;
  throw new OAuthError(code, `token endpoint error: ${code} (HTTP ${res.status})`, desc);
}

/** Common builder: the client-authentication params every grant sends. */
function clientParams(config: OAuthProviderConfig): Record<string, string> {
  const p: Record<string, string> = { client_id: config.clientId };
  if (config.clientSecret) p.client_secret = config.clientSecret;
  return p;
}

/** Exchange an authorization code (+ PKCE verifier) for a {@link TokenSet}. */
export async function exchangeAuthorizationCode(
  config: OAuthProviderConfig,
  args: { code: string; redirectUri: string; codeVerifier?: string },
  opts: { fetchImpl?: FetchLike; now?: () => number; signal?: AbortSignal } = {},
): Promise<TokenSet> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const now = opts.now ?? Date.now;
  const params: Record<string, string> = {
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    ...clientParams(config),
  };
  if (config.usesPkce && args.codeVerifier) params.code_verifier = args.codeVerifier;
  const res = await postForm(config.tokenEndpoint, params, fetchImpl, opts.signal);
  if (!res.ok) throwForBody(res);
  return tokenSetFromBody(res.body, now(), config.scopes.join(" "));
}

/**
 * Exchange a manually-pasted authorization code (+ PKCE verifier) for a
 * {@link TokenSet} — the manual-code-paste variant `flows/manual-code.ts` uses.
 * Unlike every other grant here, this POSTs a JSON body (matching what Claude
 * Code's own CLI sends to Anthropic's `platform.claude.com/v1/oauth/token`):
 * `{ grant_type, code, state, client_id, redirect_uri, code_verifier }`.
 */
export async function exchangeAuthorizationCodeManual(
  config: OAuthProviderConfig,
  args: { code: string; state: string; redirectUri: string; codeVerifier?: string },
  opts: { fetchImpl?: FetchLike; now?: () => number; signal?: AbortSignal } = {},
): Promise<TokenSet> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const now = opts.now ?? Date.now;
  const body: Record<string, unknown> = {
    grant_type: "authorization_code",
    code: args.code,
    state: args.state,
    client_id: config.clientId,
    redirect_uri: args.redirectUri,
  };
  if (config.usesPkce && args.codeVerifier) body.code_verifier = args.codeVerifier;
  const res = await postJson(config.tokenEndpoint, body, fetchImpl, opts.signal);
  if (!res.ok) throwForBody(res);
  return tokenSetFromBody(res.body, now(), config.scopes.join(" "));
}

/**
 * Exchange a refresh token for a fresh {@link TokenSet}. Per RFC 6749 a token
 * endpoint MAY omit a new `refresh_token`; when it does we carry the prior one
 * forward so the credential stays refreshable.
 *
 * A `manualCode` provider's token endpoint (Anthropic's `platform.claude.com/v1/
 * oauth/token` — the same one Claude Code's own CLI hits) expects a JSON body
 * for refresh too, mirroring the authorization-code exchange and the verified
 * ClaudeGauge `OAuthService.swift` `performRefresh`/`tokenRequest`: just
 * `{ grant_type, refresh_token, client_id }`, no `scope` and no form-encoding.
 * Every other provider keeps the standard form-encoded grant.
 */
export async function refreshTokens(
  config: OAuthProviderConfig,
  refreshToken: string,
  opts: { fetchImpl?: FetchLike; now?: () => number; signal?: AbortSignal } = {},
): Promise<TokenSet> {
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const now = opts.now ?? Date.now;
  const res = config.manualCode
    ? await postJson(
        config.tokenEndpoint,
        { grant_type: "refresh_token", refresh_token: refreshToken, client_id: config.clientId },
        fetchImpl,
        opts.signal,
      )
    : await postForm(
        config.tokenEndpoint,
        {
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: config.scopes.join(" "),
          ...clientParams(config),
        },
        fetchImpl,
        opts.signal,
      );
  if (!res.ok) throwForBody(res);
  const ts = tokenSetFromBody(res.body, now(), config.scopes.join(" "));
  if (!ts.refreshToken) ts.refreshToken = refreshToken;
  return ts;
}
