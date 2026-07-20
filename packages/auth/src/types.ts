/**
 * Core shapes for the OAuth 2.0 framework. A provider declares its REAL
 * endpoints via {@link OAuthProviderConfig}; a completed login yields a
 * {@link TokenSet}. Neither shape is ever printed verbatim — see `redact.ts`.
 */

/**
 * A minimal structural view of `fetch` so this package never depends on the DOM
 * lib for its typings and stays trivially injectable in tests (a real
 * loopback/mock HTTP server is used; nothing is faked at the protocol level).
 */
export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}
export type FetchLike = (
  input: string | URL,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponseLike>;

/**
 * The plug-in point for a provider's REAL OAuth endpoints. `usesPkce` gates the
 * S256 `code_challenge`/`code_verifier` machinery (all modern public clients set
 * it true). `deviceEndpoint` is present only for providers that implement the
 * Device Authorization Grant (RFC 8628); its absence disables the headless flow.
 */
export interface OAuthProviderConfig {
  /** Stable provider id — also the TokenStore key namespace. */
  id: string;
  /** Authorization endpoint (where the browser is sent). */
  authorizeUrl: string;
  /** Token endpoint (code→token, refresh, device-code polling). */
  tokenEndpoint: string;
  /** Device authorization endpoint (RFC 8628); enables the headless flow. */
  deviceEndpoint?: string;
  /** OAuth client id (public client for PKCE). */
  clientId: string;
  /** Client secret, only for confidential clients that require one. */
  clientSecret?: string;
  /** Requested scopes (space-joined on the wire). */
  scopes: string[];
  /** Whether to use PKCE (S256). True for every modern public client. */
  usesPkce: boolean;
  /** Optional `audience` parameter some authorization servers require. */
  audience?: string;
  /**
   * A FIXED, non-loopback redirect URI the authorization server expects (e.g.
   * Anthropic's `https://platform.claude.com/oauth/code/callback`, which
   * DISPLAYS the resulting `code#state` for the user to copy rather than
   * redirecting back to a local server). Only meaningful when `manualCode` is
   * set — the loopback flow always mints its own ephemeral redirect instead.
   */
  redirectUri?: string;
  /**
   * True when this provider's callback is a page that shows the user a
   * `<code>#<state>` string to paste back into the CLI, rather than a redirect
   * the CLI can capture itself (RFC 8252's loopback pattern). Set alongside a
   * fixed `redirectUri`. When true, `login()` runs the manual-code-paste flow
   * (see `flows/manual-code.ts`) instead of starting a loopback server.
   */
  manualCode?: boolean;
  /**
   * Extra fixed query params merged into the authorize URL (e.g. Anthropic's
   * `code=true`, which tells its authorize endpoint to render the code on the
   * callback page instead of attempting a redirect).
   */
  extraAuthorizeParams?: Record<string, string>;
}

/**
 * The persisted result of a successful authentication. `expiresAt` is an
 * absolute epoch-milliseconds instant so freshness checks need no clock other
 * than "now". A `refreshToken` is optional — not every grant returns one.
 */
export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry, epoch ms. */
  expiresAt: number;
  /** Granted scope (space-joined). */
  scope: string;
  /** Usually "Bearer". */
  tokenType: string;
}

/** Raw OAuth token-endpoint JSON body (snake_case per the specs). */
export interface TokenResponseBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}
