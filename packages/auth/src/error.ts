/**
 * `OAuthError` — the single error type this framework throws. `code` carries the
 * machine-readable reason: either a standard OAuth error code from the
 * authorization/token endpoint (`access_denied`, `authorization_pending`,
 * `slow_down`, `expired_token`, `invalid_grant`, …) or one of this framework's
 * own local codes (`state_mismatch`, `timeout`, `cancelled`, `missing_code`,
 * `no_device_endpoint`, `token_endpoint_error`, `network_error`). Messages never
 * contain a token value.
 */
export class OAuthError extends Error {
  override readonly name = "OAuthError";
  readonly code: string;
  readonly description: string | undefined;

  constructor(code: string, message: string, description?: string) {
    super(message);
    this.code = code;
    this.description = description;
  }
}

export function isOAuthError(e: unknown): e is OAuthError {
  return e instanceof OAuthError;
}
