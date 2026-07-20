/**
 * TokenSet lifecycle: build a {@link TokenSet} from a raw token-endpoint body and
 * answer freshness questions with a configurable clock skew so a token is
 * proactively refreshed BEFORE it hard-expires (never mid-request).
 */

import type { TokenResponseBody, TokenSet } from "./types.js";

/** Default freshness skew: treat a token as stale 60s before its real expiry. */
export const DEFAULT_SKEW_MS = 60_000;

function coerceExpiresIn(v: number | string | undefined): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  // No `expires_in` → treat as a short-lived token (1h) so callers still refresh.
  return 3600;
}

/**
 * Build a {@link TokenSet} from a successful token-endpoint body. `now` is the
 * moment the response was received (epoch ms); `expiresAt` is derived from it +
 * `expires_in`. When the body omits `scope`, `fallbackScope` (the requested
 * scopes) is recorded so a refresh can request the same set.
 */
export function tokenSetFromBody(
  body: TokenResponseBody,
  now: number,
  fallbackScope: string,
): TokenSet {
  const accessToken = body.access_token ?? "";
  const expiresInSec = coerceExpiresIn(body.expires_in);
  const ts: TokenSet = {
    accessToken,
    expiresAt: now + expiresInSec * 1000,
    scope: body.scope ?? fallbackScope,
    tokenType: body.token_type ?? "Bearer",
  };
  if (body.refresh_token) ts.refreshToken = body.refresh_token;
  return ts;
}

/** True when `ts` is at or past its hard expiry (no skew). */
export function isExpired(ts: TokenSet, now: number = Date.now()): boolean {
  return now >= ts.expiresAt;
}

/**
 * True when `ts` is within `skewMs` of expiry (or already past it) — the signal
 * to refresh proactively. Default skew is {@link DEFAULT_SKEW_MS}.
 */
export function needsRefresh(
  ts: TokenSet,
  now: number = Date.now(),
  skewMs: number = DEFAULT_SKEW_MS,
): boolean {
  return now >= ts.expiresAt - skewMs;
}
