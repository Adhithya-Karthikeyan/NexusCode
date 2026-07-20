/**
 * Redaction for OAuth material. Tokens must NEVER be printed. `redactSecret`
 * (from @nexuscode/config) masks a value to `…<last4>`; here we build a
 * log-safe summary of a {@link TokenSet} and a text scrubber that removes any
 * token substring from arbitrary log output.
 */

import { redactSecret, redactInText } from "@nexuscode/config";
import type { TokenSet } from "./types.js";

/** A structurally log-safe view of a TokenSet — no full token value survives. */
export interface RedactedTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scope: string;
  tokenType: string;
}

/** Mask a TokenSet's secret fields; safe to `JSON.stringify` into a log. */
export function redactTokenSet(ts: TokenSet): RedactedTokenSet {
  const out: RedactedTokenSet = {
    accessToken: redactSecret(ts.accessToken),
    expiresAt: ts.expiresAt,
    scope: ts.scope,
    tokenType: ts.tokenType,
  };
  if (ts.refreshToken) out.refreshToken = redactSecret(ts.refreshToken);
  return out;
}

/** Scrub any occurrence of `ts`'s token values from arbitrary text. */
export function redactTokensInText(text: string, ts: TokenSet): string {
  const secrets: string[] = [ts.accessToken];
  if (ts.refreshToken) secrets.push(ts.refreshToken);
  return redactInText(text, secrets);
}
