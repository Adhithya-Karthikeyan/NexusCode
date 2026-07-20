/**
 * The Google composite {@link AuthStrategy} for Gemini / Vertex.
 *
 * Google offers several REAL paths and we honor each honestly:
 *   • `gcloud` present → DELEGATE to `gcloud auth application-default login`
 *     (the recommended developer path); the `@google/genai` SDK then reads ADC.
 *   • no `gcloud`      → a genuine Google OAuth loopback (PKCE) against Google's
 *     public installed-app client, or the device flow on a headless box.
 *   • Gemini Developer API → an `"api-key"` login (GEMINI_API_KEY) — the honest
 *     path for the key-authenticated developer endpoint.
 *
 * `resolveCredential()` returns the API key when one is set (Gemini Developer
 * API), otherwise `"none"` (Vertex/ADC — the SDK resolves the chain itself). The
 * OAuth token, when obtained, is returned as a `"bearer"` for callers that can
 * use it. gcloud detection/invocation goes through the injectable exec seam.
 */

import type { SecretStore } from "@nexuscode/config";
import type { FetchLike, OAuthProviderConfig } from "../types.js";
import type { AuthStatus, AuthStrategy, LoginStrategyOptions, ResolvedCredential } from "./types.js";
import { createOAuthStrategy } from "./oauth.js";
import { createApiKeyStrategy } from "./api-key.js";
import { createCloudSsoStrategy, gcpAdcPresent } from "./cloud-sso.js";
import { defaultExec, type StrategyExec } from "./exec.js";
import { GOOGLE_OAUTH_CONFIG } from "./providers.js";

export interface GoogleAuthStrategyOptions {
  /** Provider id this strategy fronts (`"google"`, `"gemini"`, or `"vertex"`). */
  providerId?: string;
  secrets: SecretStore;
  /** Override the Google OAuth endpoints/client (tests → mock AS). */
  oauthConfig?: OAuthProviderConfig;
  /** SecretStore ref for the Gemini Developer API key (default = providerId). */
  apiKeyRef?: string;
  /** Env var checked before the store for the Gemini key. */
  apiKeyEnv?: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  env?: NodeJS.ProcessEnv;
  /** Injectable exec/fs seam for gcloud detection (default real). */
  exec?: StrategyExec;
}

/** Build the Google composite strategy (gcloud delegate + OAuth + api-key). */
export function createGoogleAuthStrategy(opts: GoogleAuthStrategyOptions): AuthStrategy {
  const providerId = opts.providerId ?? "google";
  const exec = opts.exec ?? defaultExec();
  const env = opts.env ?? process.env;

  const gcloud = createCloudSsoStrategy({
    spec: {
      providerId,
      bin: "gcloud",
      label: "gcloud ADC",
      loginArgs: ["auth", "application-default", "login"],
      credsPresent: (e) => gcpAdcPresent(e, env),
    },
    exec,
  });
  const oauth = createOAuthStrategy({
    config: opts.oauthConfig ?? GOOGLE_OAUTH_CONFIG,
    secrets: opts.secrets,
    label: "oauth (Google account)",
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const apiKey = createApiKeyStrategy({
    providerId,
    secrets: opts.secrets,
    ref: opts.apiKeyRef ?? providerId,
    ...(opts.apiKeyEnv ? { keyEnv: opts.apiKeyEnv } : {}),
    keyPageUrl: "https://aistudio.google.com/apikey",
    label: "api-key (Gemini Developer API)",
    ...(opts.openBrowser ? { openBrowser: opts.openBrowser } : {}),
    env,
  });

  const status = async (): Promise<AuthStatus> => {
    const k = await apiKey.status();
    if (k.loggedIn) return { ...k, providerId, kind: "cloud-sso" };
    if (gcpAdcPresent(exec, env)) {
      return { providerId, kind: "cloud-sso", loggedIn: true, method: "gcloud ADC", detail: "GCP ADC resolvable" };
    }
    const o = await oauth.status();
    if (o.loggedIn) return { ...o, providerId };
    const hasGcloud = exec.which("gcloud");
    return {
      providerId,
      kind: "cloud-sso",
      loggedIn: false,
      method: hasGcloud ? "gcloud ADC" : "oauth (Google account)",
      detail: hasGcloud
        ? "not logged in — run `nexus login " + providerId + "` (delegates to `gcloud auth application-default login`)"
        : "not logged in — run `nexus login " + providerId + "` (browser OAuth; or set a Gemini API key with `--api-key`)",
    };
  };

  const login = async (loginOpts: LoginStrategyOptions = {}): Promise<AuthStatus> => {
    if (loginOpts.method === "api-key") {
      const r = await apiKey.login(loginOpts);
      return { ...r, providerId, kind: "cloud-sso" };
    }
    // Prefer the recommended gcloud ADC path when gcloud is available.
    if (exec.which("gcloud")) {
      const r = await gcloud.login(loginOpts);
      return { ...r, providerId };
    }
    // Otherwise a genuine Google OAuth loopback (or device) flow.
    const r = await oauth.login(loginOpts);
    return { ...r, providerId };
  };

  const logout = async (): Promise<void> => {
    await oauth.logout();
    await apiKey.logout();
    // ADC is owned by gcloud; we do not revoke it here.
  };

  const resolveCredential = async (): Promise<ResolvedCredential> => {
    const key = await apiKey.resolveCredential();
    if (key.kind === "api-key" && key.value) return key;
    // Vertex/ADC: the SDK resolves the chain itself.
    if (gcpAdcPresent(exec, env)) return { kind: "none", value: "" };
    // A stale OAuth token with no refresh token makes `getFresh` THROW
    // (`invalid_grant`); that must not crash resolution — treat any OAuth
    // failure as "no usable OAuth cred" and degrade to `"none"`.
    try {
      const bearer = await oauth.resolveCredential();
      if (bearer.kind === "bearer" && bearer.value) return bearer;
    } catch {
      // No usable OAuth credential — fall through to `"none"`.
    }
    return { kind: "none", value: "" };
  };

  return {
    providerId,
    kind: "cloud-sso",
    label: "gcloud ADC / oauth (Google account) / api-key",
    // Google's real OAuth config DOES carry a device endpoint, so `--device`
    // is a genuine fallback here even though the outer kind is "cloud-sso".
    supportsDeviceMode: Boolean(oauth.supportsDeviceMode),
    login,
    logout,
    status,
    resolveCredential,
  };
}
