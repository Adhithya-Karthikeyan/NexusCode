/**
 * Per-provider authentication STRATEGIES + the {@link ProviderAuthRegistry}.
 * Every provider authenticates through one honest {@link AuthStrategy} kind —
 * `oauth` (real PKCE flow, auto-refreshed Bearer), `api-key` (guided key
 * capture), `cli-delegate` (the vendor CLI's own login), or `cloud-sso` (the
 * AWS/GCP credential chain). Nothing here fakes a flow a provider does not offer.
 */

export type {
  AuthStrategy,
  AuthStrategyKind,
  AuthStatus,
  ResolvedCredential,
  LoginStrategyOptions,
} from "./types.js";

export {
  binaryOnPath,
  defaultExec,
  type StrategyExec,
  type CommandResult,
  type RunOptions,
} from "./exec.js";

export {
  ANTHROPIC_OAUTH_CONFIG,
  ANTHROPIC_OAUTH_BETA,
  ANTHROPIC_API_KEY_ENV,
  ANTHROPIC_KEY_PAGE_URL,
  GOOGLE_OAUTH_CONFIG,
  OPENAI_KEY_PAGE_URL,
  OPENAI_API_KEY_ENV,
} from "./providers.js";

export { createOAuthStrategy, type OAuthStrategyOptions } from "./oauth.js";
export { createApiKeyStrategy, type ApiKeyStrategyOptions } from "./api-key.js";
export {
  createCliDelegateStrategy,
  type CliDelegateSpec,
  type CliDelegateStrategyOptions,
} from "./cli-delegate.js";
export {
  createCloudSsoStrategy,
  awsCredsPresent,
  gcpAdcPresent,
  type CloudSsoSpec,
  type CloudSsoStrategyOptions,
} from "./cloud-sso.js";
export { createAnthropicAuthStrategy, type AnthropicAuthStrategyOptions } from "./anthropic.js";
export { createGoogleAuthStrategy, type GoogleAuthStrategyOptions } from "./google.js";
export {
  ProviderAuthRegistry,
  createDefaultAuthRegistry,
  type DefaultAuthRegistryOptions,
} from "./registry.js";
