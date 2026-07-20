/**
 * REAL, public OAuth client configuration for the providers that offer OAuth for
 * programmatic access. These are the endpoints/clients the vendor's own first-party
 * tools use for a desktop/CLI login — they are public (installed-app / native
 * PKCE clients), never confidential secrets of ours. The user completes the real
 * browser login at runtime; nothing here contacts a provider at import time.
 */

import type { OAuthProviderConfig } from "../types.js";

/**
 * Anthropic's public OAuth client for a Claude ACCOUNT login — EXACTLY the flow
 * Claude Code's own CLI uses. PKCE (S256), but NOT a loopback redirect: Anthropic's
 * authorize endpoint rejects a `127.0.0.1` redirect_uri ("Invalid request format").
 * Instead `redirectUri` is the FIXED `platform.claude.com` callback page that
 * DISPLAYS the resulting `<code>#<state>` for the user to paste back into the CLI
 * (`manualCode: true` routes `login()` to the manual-code-paste flow — see
 * `flows/manual-code.ts`), and `extraAuthorizeParams` carries the `code=true` param
 * that tells the authorize endpoint to render the code instead of attempting a
 * redirect. The access token is sent to the Messages API as `Authorization: Bearer
 * …` alongside the `anthropic-beta: oauth-2025-04-20` opt-in header (see
 * {@link ANTHROPIC_OAUTH_BETA}).
 *
 * `clientId` is the public Claude Code native-client id.
 *
 * `authorizeUrl` MUST be the `claude.ai` SUBSCRIPTION authorize endpoint
 * (`claude.com/cai/oauth/authorize`), NOT the Console/API one
 * (`platform.claude.com/oauth/authorize`): only a token minted via the
 * subscription authorize endpoint can read subscription-scoped data (e.g. usage
 * limits); a Console-minted token gets HTTP 403 there, and — for this client —
 * the Console authorize endpoint is also the source of the repeated "Invalid
 * request format" error. Tokens for both are still minted at the SAME
 * `platform.claude.com` token endpoint below. `scopes` is the full six-scope set
 * Claude Code itself requests (`org:create_api_key`, `user:profile`,
 * `user:inference`, `user:sessions:claude_code`, `user:mcp_servers`,
 * `user:file_upload`) so the resulting token can read the full account surface
 * (profile, inference, and usage). Override any field via
 * `createAnthropicAuthStrategy` options (e.g. to point tests at the in-process
 * mock authorization server).
 *
 * Verified against a KNOWN-WORKING, independently-shipped implementation:
 * ClaudeGauge's `OAuthService.swift` (AI-USAGE-STATS /
 * `Sources/ClaudeGaugeCore/Services/OAuthService.swift`), which actually logs
 * into a Claude account and successfully reads `/api/oauth/usage` +
 * `/api/oauth/profile` with the token this exact config (authorize URL, token
 * endpoint, client id, redirect URI, and scope set) produces. The token
 * endpoint, redirect URI, and client id below were ALSO confirmed directly from
 * the real, installed `claude` binary (v2.1.215).
 */
export const ANTHROPIC_OAUTH_CONFIG: OAuthProviderConfig = {
  id: "anthropic",
  authorizeUrl: "https://claude.com/cai/oauth/authorize",
  tokenEndpoint: "https://platform.claude.com/v1/oauth/token",
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  scopes: [
    "org:create_api_key",
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
  ],
  usesPkce: true,
  redirectUri: "https://platform.claude.com/oauth/code/callback",
  manualCode: true,
  extraAuthorizeParams: { code: "true" },
};

/** The beta opt-in header the Messages API requires for an OAuth bearer token. */
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

/** The env var / SecretStore ref under which an Anthropic console API key lives. */
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
/**
 * The Anthropic key page a guided api-key login points the user at. Anthropic
 * migrated its console key management to `platform.claude.com` — the old
 * `console.anthropic.com/settings/keys` now bounces through a stale
 * `platform.claude.com/login?returnTo=...` redirect, so this MUST stay the
 * current `platform.claude.com` URL.
 */
export const ANTHROPIC_KEY_PAGE_URL = "https://platform.claude.com/settings/keys";

/**
 * Google's public installed-app OAuth client (the well-known `gcloud` native
 * client credentials — public, not a confidential secret). PKCE + a device
 * endpoint for headless boxes. `cloud-platform` scope covers Vertex AI. The
 * preferred REAL path on a developer machine is still delegating to
 * `gcloud auth application-default login` (see the Google cloud-sso strategy);
 * this config backs a genuine loopback OAuth when gcloud is absent.
 */
// NOTE on `clientSecret`: this is the well-known PUBLIC `gcloud` installed-app
// client secret — the same one shipped in Google's own first-party CLI tooling.
// It is not a confidential credential (RFC 8252 §8.4 covers native/installed
// apps using a "secret" that can't actually be kept secret; PKCE — enabled via
// `usesPkce` above — is the real protection for the authorization code). It is
// still overridable via `NEXUS_GOOGLE_OAUTH_CLIENT_SECRET` so a deployment can
// swap in its own registered client instead of the public default.
const GOOGLE_OAUTH_CLIENT_SECRET =
  process.env["NEXUS_GOOGLE_OAUTH_CLIENT_SECRET"] ?? "d-FL95Q19q7MQmFpd7hHD0Ty";

export const GOOGLE_OAUTH_CONFIG: OAuthProviderConfig = {
  id: "google",
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  deviceEndpoint: "https://oauth2.googleapis.com/device/code",
  clientId: "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com",
  clientSecret: GOOGLE_OAUTH_CLIENT_SECRET,
  scopes: ["https://www.googleapis.com/auth/cloud-platform", "openid", "email"],
  usesPkce: true,
};

/** OpenAI has no OAuth for API access; its key page for a guided api-key login. */
export const OPENAI_KEY_PAGE_URL = "https://platform.openai.com/api-keys";
export const OPENAI_API_KEY_ENV = "OPENAI_API_KEY";
