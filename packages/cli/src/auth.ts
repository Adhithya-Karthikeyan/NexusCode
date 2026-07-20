/**
 * CLI authentication wiring (Wave 13): turn the loaded config + a SecretStore
 * into a live `ProviderAuthRegistry` so `nexus login` / `logout` / `auth status`
 * run the RIGHT honest flow per provider and the runtime resolves the right
 * credential (an auto-refreshed OAuth Bearer, an API key, a wrapped-CLI session,
 * or the cloud credential chain).
 *
 * This is the one place the CLI applies `config.auth` overrides: a per-provider
 * `method` pin plus OAuth client/endpoint overrides for an enterprise or
 * self-hosted authorization server (and the in-process mock AS used by the
 * offline tests). Everything is additive — with no `auth` config the honest
 * built-in defaults from `createDefaultAuthRegistry` apply unchanged.
 */

import {
  createDefaultAuthRegistry,
  createAnthropicAuthStrategy,
  createGoogleAuthStrategy,
  createOAuthStrategy,
  createApiKeyStrategy,
  ANTHROPIC_OAUTH_CONFIG,
  ANTHROPIC_API_KEY_ENV,
  GOOGLE_OAUTH_CONFIG,
  openBrowser as defaultOpenBrowser,
  type ProviderAuthRegistry,
  type AuthStatus,
  type FetchLike,
  type OAuthProviderConfig,
} from "@nexuscode/auth";
import {
  createSecretStore,
  type NexusConfig,
  type AuthProviderOverride,
  type SecretStore,
} from "@nexuscode/config";
import { userConfigDir } from "./config-io.js";

/** Injectable seams for building the auth registry (tests inject a mock AS). */
export interface AuthRegistryOptions {
  /** Best-effort browser opener (default the real platform launcher). */
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  /** Injected fetch for OAuth flows/refresh (tests → in-process mock AS). */
  fetchImpl?: FetchLike;
  /** Injected clock (default Date.now). */
  now?: () => number;
  /** Injected env (default process.env). */
  env?: NodeJS.ProcessEnv;
}

/** True when the override carries any OAuth endpoint/client field to apply. */
function hasOAuthOverride(ov: AuthProviderOverride): boolean {
  return Boolean(
    ov.clientId || ov.authorizeUrl || ov.tokenEndpoint || ov.deviceEndpoint || ov.scopes,
  );
}

/** Merge a base OAuth config with the config.auth override fields that are set. */
function mergeOAuthConfig(
  base: OAuthProviderConfig,
  ov: AuthProviderOverride,
): OAuthProviderConfig {
  const merged: OAuthProviderConfig = { ...base };
  if (ov.clientId) merged.clientId = ov.clientId;
  if (ov.authorizeUrl) merged.authorizeUrl = ov.authorizeUrl;
  if (ov.tokenEndpoint) merged.tokenEndpoint = ov.tokenEndpoint;
  if (ov.deviceEndpoint) merged.deviceEndpoint = ov.deviceEndpoint;
  if (ov.scopes && ov.scopes.length > 0) merged.scopes = [...ov.scopes];
  return merged;
}

/**
 * Build the {@link ProviderAuthRegistry} for this config + SecretStore. Starts
 * from the honest per-provider defaults, then re-registers any provider that has
 * an OAuth client/endpoint override in `config.auth.providers` so an enterprise /
 * self-hosted authorization server (or the test mock AS) is used instead of the
 * vendor default. Never contacts the network at build time.
 */
export function buildAuthRegistry(
  config: NexusConfig,
  secrets: SecretStore,
  opts: AuthRegistryOptions = {},
): ProviderAuthRegistry {
  const openBrowser = opts.openBrowser ?? ((url: string) => defaultOpenBrowser(url));
  const env = opts.env ?? process.env;
  const reg = createDefaultAuthRegistry({
    secrets,
    openBrowser,
    env,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });

  // Apply per-provider OAuth endpoint/client overrides (enterprise/self-host/tests).
  for (const [id, ov] of Object.entries(config.auth.providers)) {
    if (!hasOAuthOverride(ov)) continue;
    if (id === "anthropic") {
      reg.register(
        createAnthropicAuthStrategy({
          secrets,
          oauthConfig: mergeOAuthConfig(ANTHROPIC_OAUTH_CONFIG, ov),
          apiKeyRef: "anthropic",
          apiKeyEnv: ANTHROPIC_API_KEY_ENV,
          openBrowser,
          env,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.now ? { now: opts.now } : {}),
        }),
      );
      continue;
    }
    if (id === "gemini" || id === "vertex") {
      reg.register(
        createGoogleAuthStrategy({
          providerId: id,
          secrets,
          apiKeyRef: "gemini",
          ...(id === "gemini" ? { apiKeyEnv: "GEMINI_API_KEY" } : {}),
          oauthConfig: mergeOAuthConfig(GOOGLE_OAUTH_CONFIG, ov),
          openBrowser,
          env,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.now ? { now: opts.now } : {}),
        }),
      );
      continue;
    }
    // Any other provider with an explicit OAuth override → a generic real OAuth
    // strategy over the supplied endpoints (requires at least authorize+token+client).
    if (ov.authorizeUrl && ov.tokenEndpoint && ov.clientId) {
      const cfg: OAuthProviderConfig = {
        id,
        authorizeUrl: ov.authorizeUrl,
        tokenEndpoint: ov.tokenEndpoint,
        clientId: ov.clientId,
        scopes: ov.scopes ?? [],
        usesPkce: true,
        ...(ov.deviceEndpoint ? { deviceEndpoint: ov.deviceEndpoint } : {}),
      };
      reg.register(
        createOAuthStrategy({
          config: cfg,
          secrets,
          label: `oauth (${id})`,
          ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
          ...(opts.now ? { now: opts.now } : {}),
        }),
      );
    }
  }

  // Keep the api-key factory referenced so an unused-import lint never fires when
  // no override path needs it directly (it is used by the default registry).
  void createApiKeyStrategy;
  return reg;
}

/**
 * Create the SecretStore that persists OAuth tokens + keys, honoring
 * `config.auth.tokenStore`: `keychain` forces the OS keychain, `file` forces the
 * encrypted-file backend, and `auto` (default) prefers the keychain but degrades
 * to the encrypted file in a headless context (no TTY) where a keychain unlock
 * dialog would block — per the Wave-13 "prefer a storage path that does not
 * GUI-block" rule. Reads still fall through the whole chain, so a token written
 * to the file is found even by a keychain-enabled store later.
 */
export function resolveAuthSecrets(
  config: NexusConfig,
  opts: { isTTY?: boolean } = {},
): SecretStore {
  const hint = config.auth.tokenStore;
  const isTTY = opts.isTTY ?? Boolean(process.stdout.isTTY);
  const disableKeychain = hint === "file" || (hint === "auto" && !isTTY);
  return createSecretStore(disableKeychain ? { disableKeychain: true } : {});
}

/** A log-safe row for `auth status` / `doctor` — never carries a token value. */
export interface AuthStatusRow {
  providerId: string;
  kind: string;
  loggedIn: boolean;
  method: string;
  detail?: string;
  /** Human "expires in ~Nm" (bearer only), or undefined. */
  expiresIn?: string;
}

/** Format an epoch-ms expiry as a short "~Nm"/"~Nh" relative string. */
export function formatExpiry(expiresAt: number | undefined, now: number = Date.now()): string | undefined {
  if (expiresAt === undefined) return undefined;
  const ms = expiresAt - now;
  if (ms <= 0) return "expired";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `~${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `~${hours}h`;
  return `~${Math.round(hours / 24)}d`;
}

/** Snapshot every registered provider's login state (no prompting, no network). */
export async function authStatusRows(
  registry: ProviderAuthRegistry,
  now: number = Date.now(),
): Promise<AuthStatusRow[]> {
  const statuses = await registry.statusAll();
  return statuses
    .map((s: AuthStatus) => {
      const row: AuthStatusRow = {
        providerId: s.providerId,
        kind: s.kind,
        loggedIn: s.loggedIn,
        method: s.method,
      };
      if (s.detail) row.detail = s.detail;
      const exp = formatExpiry(s.expiresAt, now);
      if (exp) row.expiresIn = exp;
      return row;
    })
    .sort((a, b) => a.providerId.localeCompare(b.providerId));
}

/** The user config directory the CLI persists config to (re-export for callers). */
export { userConfigDir };
