/**
 * The Anthropic composite {@link AuthStrategy} — "login like Claude Code".
 *
 * It layers two REAL strategies:
 *   • an `"oauth"` strategy over Anthropic's public Claude-account OAuth endpoints
 *     (PKCE loopback) — the DEFAULT, sending an auto-refreshed `Bearer` token; and
 *   • an `"api-key"` strategy over the Anthropic console key — the explicit
 *     alternative the user can choose (`login({ method: "api-key" })`).
 *
 * `resolveCredential()` prefers a stored OAuth token (Bearer) and falls back to
 * the API key (x-api-key) — so if the OAuth client cannot be used the strategy
 * DEGRADES to api-key with a clear status message instead of faking OAuth.
 */

import type { SecretStore } from "@nexuscode/config";
import type { FetchLike, OAuthProviderConfig } from "../types.js";
import type { AuthStatus, AuthStrategy, LoginStrategyOptions, ResolvedCredential } from "./types.js";
import { createOAuthStrategy } from "./oauth.js";
import { createApiKeyStrategy } from "./api-key.js";
import {
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_KEY_PAGE_URL,
  ANTHROPIC_OAUTH_CONFIG,
} from "./providers.js";

export interface AnthropicAuthStrategyOptions {
  secrets: SecretStore;
  /** Override the OAuth endpoints/client (tests point at the mock AS). */
  oauthConfig?: OAuthProviderConfig;
  /** SecretStore ref the console API key lives under (default `"anthropic"`). */
  apiKeyRef?: string;
  /** Env var checked before the store for the console key. */
  apiKeyEnv?: string;
  /** Injected fetch for the OAuth flow/refresh (tests → mock AS). */
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Best-effort browser opener (default none; the CLI injects the real one). */
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  env?: NodeJS.ProcessEnv;
}

/** Build the Anthropic composite (OAuth default + api-key alternative). */
export function createAnthropicAuthStrategy(opts: AnthropicAuthStrategyOptions): AuthStrategy {
  const providerId = "anthropic";
  const oauth = createOAuthStrategy({
    config: opts.oauthConfig ?? ANTHROPIC_OAUTH_CONFIG,
    secrets: opts.secrets,
    label: "oauth (Claude account)",
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const apiKey = createApiKeyStrategy({
    providerId,
    secrets: opts.secrets,
    ref: opts.apiKeyRef ?? "anthropic",
    keyEnv: opts.apiKeyEnv ?? ANTHROPIC_API_KEY_ENV,
    keyPageUrl: ANTHROPIC_KEY_PAGE_URL,
    label: "api-key (console key)",
    ...(opts.openBrowser ? { openBrowser: opts.openBrowser } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });

  const status = async (): Promise<AuthStatus> => {
    const o = await oauth.status();
    if (o.loggedIn) return o;
    const k = await apiKey.status();
    if (k.loggedIn) return k;
    // Neither present: report the OAuth-first default as the actionable state.
    return {
      providerId,
      kind: "oauth",
      loggedIn: false,
      method: "oauth (Claude account)",
      detail: "not logged in — run `nexus login anthropic` (or `--api-key` for a console key)",
    };
  };

  const login = async (loginOpts: LoginStrategyOptions = {}): Promise<AuthStatus> => {
    if (loginOpts.method === "api-key") return apiKey.login(loginOpts);
    // Default: the real OAuth (Claude account) flow.
    return oauth.login(loginOpts);
  };

  const logout = async (): Promise<void> => {
    // Clear BOTH stores so a logout is unambiguous regardless of which was used.
    await oauth.logout();
    await apiKey.logout();
  };

  const resolveCredential = async (): Promise<ResolvedCredential> => {
    // Prefer the OAuth bearer (auto-refreshed); degrade to the API key.
    // A stale OAuth token with no refresh token makes `getFresh` THROW
    // (`invalid_grant`). That must NOT crash resolution when a valid console
    // key is present — treat any OAuth failure as "no usable OAuth cred" and
    // fall through to the api-key path (the documented DEGRADES contract).
    try {
      const bearer = await oauth.resolveCredential();
      if (bearer.kind === "bearer" && bearer.value) return bearer;
    } catch {
      // No usable OAuth credential — fall through to api-key.
    }
    const key = await apiKey.resolveCredential();
    if (key.kind === "api-key" && key.value) return key;
    return { kind: "none", value: "" };
  };

  return {
    providerId,
    kind: "oauth",
    label: "oauth (Claude account) or api-key (console key)",
    // Anthropic's real OAuth config has no `deviceEndpoint` — reflect the
    // underlying oauth strategy's honest capability rather than assuming.
    supportsDeviceMode: Boolean(oauth.supportsDeviceMode),
    login,
    logout,
    status,
    resolveCredential,
  };
}
