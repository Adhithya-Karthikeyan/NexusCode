/**
 * `TokenStore` — persists a {@link TokenSet} per provider through the
 * @nexuscode/config `SecretStore` chain (env → OS keychain → encrypted file), so
 * OAuth tokens get the same secure-at-rest, never-logged handling as API keys.
 * The whole TokenSet is serialized to JSON under a namespaced ref
 * (`oauth:<providerId>`). `getFresh` transparently refreshes a token that is
 * within the skew of expiry and re-persists the result.
 */

import type { SecretStore } from "@nexuscode/config";
import { OAuthError } from "./error.js";
import { refreshTokens } from "./token-endpoint.js";
import { needsRefresh, DEFAULT_SKEW_MS } from "./tokenset.js";
import type { FetchLike, OAuthProviderConfig, TokenSet } from "./types.js";

/** Namespaced SecretStore ref for a provider's OAuth token bundle. */
export function tokenRef(providerId: string): string {
  return `oauth:${providerId}`;
}

function isTokenSet(v: unknown): v is TokenSet {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.accessToken === "string" &&
    typeof o.expiresAt === "number" &&
    typeof o.scope === "string" &&
    typeof o.tokenType === "string"
  );
}

export interface TokenStore {
  /** Read the stored TokenSet for a provider, or null if none. */
  get(providerId: string): Promise<TokenSet | null>;
  /** Persist (overwrite) a provider's TokenSet. */
  set(providerId: string, tokens: TokenSet): Promise<void>;
  /** Remove a provider's stored TokenSet from every backend. */
  clear(providerId: string): Promise<void>;
  /**
   * Read the TokenSet and, if it is within the refresh skew of expiry and a
   * refresh token is available, refresh it against `config`'s token endpoint,
   * persist the new set, and return it. Returns null if nothing is stored.
   * Throws if the token is stale but not refreshable (no refresh token).
   */
  getFresh(providerId: string, config: OAuthProviderConfig): Promise<TokenSet | null>;
}

export interface TokenStoreOptions {
  /** Injected fetch for refresh calls (default global fetch); tests override. */
  fetchImpl?: FetchLike;
  /** Injected clock (default Date.now). */
  now?: () => number;
  /** Refresh skew in ms (default {@link DEFAULT_SKEW_MS}). */
  skewMs?: number;
}

class SecretStoreTokenStore implements TokenStore {
  constructor(
    private readonly secrets: SecretStore,
    private readonly opts: TokenStoreOptions,
  ) {}

  async get(providerId: string): Promise<TokenSet | null> {
    const raw = await this.secrets.get(tokenRef(providerId));
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return isTokenSet(parsed) ? parsed : null;
  }

  async set(providerId: string, tokens: TokenSet): Promise<void> {
    await this.secrets.set(tokenRef(providerId), JSON.stringify(tokens));
  }

  async clear(providerId: string): Promise<void> {
    await this.secrets.delete(tokenRef(providerId));
  }

  async getFresh(providerId: string, config: OAuthProviderConfig): Promise<TokenSet | null> {
    const now = this.opts.now ?? Date.now;
    const skew = this.opts.skewMs ?? DEFAULT_SKEW_MS;
    const current = await this.get(providerId);
    if (!current) return null;
    if (!needsRefresh(current, now(), skew)) return current;

    if (!current.refreshToken) {
      throw new OAuthError(
        "invalid_grant",
        `token for "${providerId}" is expired and has no refresh token — re-run login`,
      );
    }
    const refreshed = await refreshTokens(config, current.refreshToken, {
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      now,
    });
    await this.set(providerId, refreshed);
    return refreshed;
  }
}

/** Create a {@link TokenStore} backed by a @nexuscode/config `SecretStore`. */
export function createTokenStore(secrets: SecretStore, opts: TokenStoreOptions = {}): TokenStore {
  return new SecretStoreTokenStore(secrets, opts);
}
