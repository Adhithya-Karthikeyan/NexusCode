/**
 * Bearer-token authentication for the REST daemon. The token is either supplied
 * explicitly, resolved from the `SecretStore` (so it survives restarts), or —
 * on first run — generated and persisted through the store. It is NEVER read
 * from, or written to, the config cascade or the trace/history stores.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "@nexuscode/config";

/** SecretStore ref under which the daemon's bearer token is persisted. */
export const SERVER_TOKEN_REF = "nexus.server.token";

/** Mint a fresh, URL-safe bearer token (256 bits of entropy). */
export function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Resolve the daemon's bearer token: an explicit token wins; otherwise the
 * value stored under {@link SERVER_TOKEN_REF} is used; otherwise a new token is
 * generated and persisted (first-run bootstrap). Returns the token and whether
 * it was freshly generated (so the caller can print it once on startup).
 */
export async function resolveAuthToken(opts: {
  token?: string | undefined;
  secrets?: SecretStore | undefined;
}): Promise<{ token: string; generated: boolean }> {
  if (opts.token && opts.token.length > 0) {
    return { token: opts.token, generated: false };
  }
  if (opts.secrets) {
    const existing = await opts.secrets.get(SERVER_TOKEN_REF);
    if (existing && existing.length > 0) {
      return { token: existing, generated: false };
    }
    const fresh = generateToken();
    await opts.secrets.set(SERVER_TOKEN_REF, fresh);
    return { token: fresh, generated: true };
  }
  return { token: generateToken(), generated: true };
}

/** Extract the presented bearer token from an `Authorization` header value. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? (match[1] as string).trim() : null;
}

/**
 * Constant-time comparison of the presented token against the expected one.
 * Length is compared up front (unavoidably), but the byte comparison itself is
 * timing-safe so a wrong token cannot be discovered character by character.
 */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
