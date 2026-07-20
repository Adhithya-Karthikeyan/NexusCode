/**
 * @nexuscode/auth — a real OAuth 2.0 authentication framework for NexusCode.
 *
 * - PKCE (S256) + CSRF-state helpers (`pkce.ts`).
 * - Authorization Code + PKCE flow over a 127.0.0.1 loopback redirect
 *   (`flows/authcode.ts`).
 * - Device Authorization Grant headless fallback (`flows/device.ts`).
 * - Manual-code-paste flow for providers whose callback page displays the code
 *   instead of redirecting (Anthropic "login like Claude Code") (`flows/manual-code.ts`).
 * - TokenSet lifecycle: build/expiry/refresh-skew (`tokenset.ts`).
 * - Token endpoint HTTP: code exchange + refresh (`token-endpoint.ts`).
 * - `TokenStore` persisting TokenSets via the config `SecretStore`, with
 *   auto-refresh on read (`store.ts`).
 * - `login`/`logout` convenience that picks the flow and persists the result
 *   (`login.ts`), and redaction helpers so tokens never reach a log (`redact.ts`).
 */

export * from "./types.js";
export * from "./error.js";
export * from "./pkce.js";
export * from "./tokenset.js";
export * from "./token-endpoint.js";
export * from "./redact.js";
export * from "./browser.js";
export * from "./store.js";
export * from "./login.js";
export {
  runAuthorizationCodeFlow,
  buildAuthorizeUrl,
  type AuthCodeFlowOptions,
} from "./flows/authcode.js";
export {
  runDeviceCodeFlow,
  requestDeviceAuthorization,
  type DeviceCodeFlowOptions,
  type DeviceAuthorization,
} from "./flows/device.js";
export {
  runManualCodeFlow,
  splitPastedCode,
  type ManualCodeFlowOptions,
  type SplitPastedCode,
} from "./flows/manual-code.js";

// Per-provider auth strategies + the ProviderAuthRegistry (Wave 13): the seam
// that runs the RIGHT login flow per provider and resolves the credential each
// adapter should send (an auto-refreshed OAuth Bearer, an API key, or "none"
// for a wrapped-CLI / cloud-SSO session).
export * from "./strategies/index.js";
