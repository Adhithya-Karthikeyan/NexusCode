/**
 * The `"oauth"` {@link AuthStrategy}: a thin, provider-agnostic wrapper over the
 * REAL Authorization Code + PKCE (or device) flow and the SecretStore-backed
 * {@link TokenStore}. `login()` runs the genuine flow (browser loopback by
 * default) and persists the token bundle; `resolveCredential()` reads it back and
 * transparently refreshes a near-expiry access token; `status()` reports login
 * state without prompting; `logout()` clears the stored tokens.
 */

import { login as runLogin, logout as runLogout } from "../login.js";
import { createTokenStore, type TokenStore, type TokenStoreOptions } from "../store.js";
import { needsRefresh } from "../tokenset.js";
import type { SecretStore } from "@nexuscode/config";
import type { FetchLike, OAuthProviderConfig } from "../types.js";
import type { AuthStatus, AuthStrategy, LoginStrategyOptions, ResolvedCredential } from "./types.js";

export interface OAuthStrategyOptions {
  /** The provider's REAL OAuth endpoints/client. */
  config: OAuthProviderConfig;
  /** The SecretStore that persists the token bundle (or a prebuilt TokenStore). */
  secrets?: SecretStore;
  store?: TokenStore;
  /** Human method label for status/UX (default `"oauth"`). */
  label?: string;
  /** Injected fetch (tests point this at the in-process mock AS). */
  fetchImpl?: FetchLike;
  /** Injected clock (default Date.now). */
  now?: () => number;
  /** TokenStore refresh options (skew, etc.). */
  storeOptions?: TokenStoreOptions;
}

/** Build an `"oauth"` strategy for `config`. */
export function createOAuthStrategy(opts: OAuthStrategyOptions): AuthStrategy {
  const config = opts.config;
  const now = opts.now ?? Date.now;
  const label = opts.label ?? "oauth";
  const storeOpts: TokenStoreOptions = {
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    now,
    ...(opts.storeOptions ?? {}),
  };
  const store =
    opts.store ??
    (opts.secrets
      ? createTokenStore(opts.secrets, storeOpts)
      : (() => {
          throw new Error("createOAuthStrategy requires either `secrets` or `store`");
        })());

  const providerId = config.id;

  const status = async (): Promise<AuthStatus> => {
    const ts = await store.get(providerId);
    if (!ts) {
      return { providerId, kind: "oauth", loggedIn: false, method: label, detail: "not logged in" };
    }
    const stale = needsRefresh(ts, now(), storeOpts.skewMs);
    const refreshable = Boolean(ts.refreshToken);
    // Logged in as long as a refresh token exists (a stale access token is
    // silently refreshed on use) or the access token is still fresh.
    const loggedIn = refreshable || !stale;
    const remainingMs = ts.expiresAt - now();
    const detail = stale
      ? refreshable
        ? "access token expired — will refresh on next use"
        : "expired and not refreshable — re-run login"
      : `token valid for ~${Math.max(0, Math.round(remainingMs / 60_000))}m`;
    return { providerId, kind: "oauth", loggedIn, method: label, detail, expiresAt: ts.expiresAt };
  };

  const login = async (loginOpts: LoginStrategyOptions = {}): Promise<AuthStatus> => {
    await runLogin({
      config,
      store,
      mode: loginOpts.mode ?? "browser",
      ...(loginOpts.onAuthorizeUrl ? { onAuthorizeUrl: loginOpts.onAuthorizeUrl } : {}),
      ...(loginOpts.onDevicePrompt
        ? {
            onDevicePrompt: (d) =>
              loginOpts.onDevicePrompt?.({
                userCode: d.userCode,
                verificationUri: d.verificationUriComplete ?? d.verificationUri,
              }),
          }
        : {}),
      ...(loginOpts.openBrowser ? { openBrowser: loginOpts.openBrowser } : {}),
      ...(loginOpts.readCode ? { readCode: loginOpts.readCode } : {}),
      ...(loginOpts.signal ? { signal: loginOpts.signal } : {}),
      ...(loginOpts.timeoutMs !== undefined ? { timeoutMs: loginOpts.timeoutMs } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      now,
    });
    return status();
  };

  const logout = async (): Promise<void> => {
    await runLogout(store, providerId);
  };

  const resolveCredential = async (): Promise<ResolvedCredential> => {
    // `getFresh` refreshes a near-expiry token against the real token endpoint
    // and re-persists it, so the adapter always receives a valid bearer token.
    const ts = await store.getFresh(providerId, config);
    if (!ts) return { kind: "none", value: "" };
    return { kind: "bearer", value: ts.accessToken, expiresAt: ts.expiresAt };
  };

  return {
    providerId,
    kind: "oauth",
    label,
    supportsDeviceMode: Boolean(config.deviceEndpoint),
    login,
    logout,
    status,
    resolveCredential,
  };
}
