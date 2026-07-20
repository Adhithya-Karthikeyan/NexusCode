/**
 * PKCE (RFC 7636) + CSRF-state helpers built on `node:crypto`. The verifier is a
 * high-entropy URL-safe secret; the challenge is its SHA-256 digest, base64url
 * encoded (the S256 method — the only one we use, never "plain"). `state` is an
 * independent random value that binds the browser round-trip to this attempt.
 */

import { randomBytes, createHash } from "node:crypto";

/** RFC 4648 §5 base64url with no padding. */
export function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A PKCE pair: the secret `verifier` and its derived S256 `challenge`. */
export interface PkcePair {
  verifier: string;
  challenge: string;
  method: "S256";
}

/**
 * Generate a code verifier: 32 random bytes → 43-char base64url string, safely
 * inside RFC 7636's 43–128 character range.
 */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** Derive the S256 code challenge = base64url(SHA-256(verifier)). */
export function computeCodeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** Generate a full PKCE pair (verifier + S256 challenge). */
export function createPkcePair(): PkcePair {
  const verifier = generateCodeVerifier();
  return { verifier, challenge: computeCodeChallenge(verifier), method: "S256" };
}

/**
 * Generate an opaque CSRF `state` value (32 random bytes, base64url) — the same
 * size as the verifier, matching the verified ClaudeGauge `OAuthService.swift`
 * (`randomURLSafe(32)` is used for both the verifier and `state`).
 */
export function generateState(): string {
  return base64url(randomBytes(32));
}
