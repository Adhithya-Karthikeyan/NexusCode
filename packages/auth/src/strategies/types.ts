/**
 * The per-provider AUTH STRATEGY seam. Every provider authenticates through one
 * of four honest kinds — never a faked flow:
 *
 *   • `"oauth"`       — a REAL OAuth 2.0 Authorization Code + PKCE (or device)
 *                       flow against the provider's public endpoints; the
 *                       resulting access token is auto-refreshed and handed to
 *                       the adapter as a `Bearer` Authorization (e.g. Anthropic
 *                       "login like Claude Code").
 *   • `"api-key"`     — the provider authenticates by an API key (e.g. the
 *                       OpenAI API); `login()` GUIDES the user to their key page
 *                       and captures/stores the key securely. It is clearly
 *                       labeled api-key — never dressed up as OAuth.
 *   • `"cli-delegate"`— a wrapped vendor coding-CLI (claude / codex / gemini)
 *                       owns its OWN login; `login()` runs that CLI's real login
 *                       subcommand and `status()` detects its existing session.
 *                       This is the correct NON-reimplemented path — we never
 *                       re-derive the vendor's OAuth.
 *   • `"cloud-sso"`   — a cloud SDK (AWS Bedrock / GCP Vertex) authenticates via
 *                       its own credential chain; `login()` delegates to
 *                       `aws sso login` / `gcloud auth …` and `resolveCredential`
 *                       returns "none" (the SDK reads the chain itself).
 */

/** The four honest authentication kinds a provider strategy can be. */
export type AuthStrategyKind = "oauth" | "cli-delegate" | "api-key" | "cloud-sso";

/**
 * What the adapter should actually send. `"bearer"` → an `Authorization: Bearer
 * <value>` (an OAuth access token, auto-refreshed). `"api-key"` → the provider's
 * native API-key header (e.g. `x-api-key`), value is the key. `"none"` → the
 * adapter/SDK resolves credentials itself (a wrapped CLI's own session, or the
 * AWS/GCP credential chain); `value` is empty.
 */
export interface ResolvedCredential {
  kind: "bearer" | "api-key" | "none";
  /** The token or key. Empty string for `"none"`. NEVER logged. */
  value: string;
  /** When set, an epoch-ms expiry for a bearer token (post-refresh). */
  expiresAt?: number;
}

/** A log-safe snapshot of a provider's login state. Contains no secret value. */
export interface AuthStatus {
  providerId: string;
  kind: AuthStrategyKind;
  /** True when a usable credential/session is present right now. */
  loggedIn: boolean;
  /**
   * Human-readable method label, e.g. `"oauth (Claude account)"`, `"api-key"`,
   * `"cli session (claude)"`, `"aws sso"`. Safe to print.
   */
  method: string;
  /** Extra, non-secret detail (e.g. "token expires in 42m", "gcloud not found"). */
  detail?: string;
  /** For an OAuth strategy: the current access-token expiry (epoch ms). */
  expiresAt?: number;
}

/** Options threaded into a strategy's `login()`. All optional and injectable. */
export interface LoginStrategyOptions {
  /**
   * For a composite strategy (Anthropic) that supports more than one method:
   * force `"oauth"` (Claude account) or `"api-key"` (console key). Ignored by
   * single-method strategies.
   */
  method?: "oauth" | "api-key";
  /** OAuth flow mode: browser loopback (default), device code, or auto. */
  mode?: "browser" | "device" | "auto";
  /** Surface the browser authorize URL (printed for manual paste). */
  onAuthorizeUrl?: (url: string) => void;
  /** Surface the device code + verification URL (headless OAuth). */
  onDevicePrompt?: (info: { userCode: string; verificationUri: string }) => void;
  /**
   * Manual-code-paste providers only (e.g. Anthropic "login like Claude Code"):
   * read the `code#state` string the user copies from the authorize callback
   * page. Ignored by every other provider/flow.
   */
  readCode?: () => Promise<string>;
  /** Override the browser opener (default platform launcher; tests inject). */
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  /**
   * For an api-key strategy: the captured key value (e.g. read from a hidden
   * TTY prompt by the CLI). When omitted, `readKey` is tried.
   */
  apiKey?: string;
  /** For an api-key strategy: lazily read the key (e.g. prompt on the TTY). */
  readKey?: () => Promise<string>;
  /** For an api-key strategy: called with the provider's key page URL to open. */
  onKeyPage?: (url: string) => void;
  /**
   * For an api-key strategy: opt in to actually opening the key page in a
   * browser. Default `false` — the URL is always surfaced via `onKeyPage`
   * (printed for the user to open themselves), but auto-launching a browser
   * to a provider's key page during a plain api-key login is surprising by
   * default (and can land on a login wall). Wired from the CLI's `--open`
   * flag or a config opt-in.
   */
  autoOpenBrowser?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * A provider's authentication strategy. `login`/`logout`/`status` manage the
 * credential lifecycle; `resolveCredential` returns exactly what the adapter
 * must send on each call (auto-refreshing an OAuth token as needed).
 */
export interface AuthStrategy {
  readonly providerId: string;
  readonly kind: AuthStrategyKind;
  /** Human label for the primary method (e.g. "oauth (Claude account)"). */
  readonly label: string;
  /**
   * True only when this strategy has a REAL device-code endpoint to hit (RFC
   * 8628), so `--device` actually starts a genuine headless flow. Undefined/
   * false for every provider without one (e.g. Anthropic's OAuth config has no
   * `deviceEndpoint`) and for every non-OAuth kind (api-key / cli-delegate /
   * cloud-sso) — callers MUST check this before honoring `--device` instead of
   * attempting a flow that doesn't exist.
   */
  readonly supportsDeviceMode?: boolean;
  /**
   * `"api-key"` strategies only: the env var checked before the stored key
   * (e.g. `"OPENAI_API_KEY"`), surfaced so a rejected `--device` login (or any
   * other guidance) can point the user at it. Undefined for other kinds.
   */
  readonly apiKeyEnv?: string;
  /** Run the real login flow; resolves with the resulting {@link AuthStatus}. */
  login(opts?: LoginStrategyOptions): Promise<AuthStatus>;
  /** Remove any stored credential / end the local session record. */
  logout(): Promise<void>;
  /** Report the current login state without prompting or opening a browser. */
  status(): Promise<AuthStatus>;
  /**
   * Resolve the credential the adapter should use RIGHT NOW. For an OAuth
   * strategy this transparently refreshes a near-expiry access token before
   * returning it. Never prints or logs the value.
   */
  resolveCredential(): Promise<ResolvedCredential>;
}
