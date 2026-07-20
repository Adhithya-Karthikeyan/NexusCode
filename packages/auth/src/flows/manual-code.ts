/**
 * Manual-code-paste flow — how Claude Code's own CLI signs a user into a Claude
 * account, and what we replicate exactly for Anthropic (see `ANTHROPIC_OAUTH_CONFIG`
 * in `strategies/providers.ts`). Anthropic's authorization endpoint rejects a
 * loopback `redirect_uri` ("Invalid request format"); instead it expects a FIXED,
 * non-loopback `redirect_uri` (`https://platform.claude.com/oauth/code/callback`)
 * whose callback page DISPLAYS the resulting `<code>#<state>` for the user to copy,
 * rather than redirecting back to a local server. We:
 *   1. mint a PKCE pair + CSRF `state`;
 *   2. build the authorize URL (client_id, the fixed redirect_uri, scope, state,
 *      code_challenge, plus any `extraAuthorizeParams` like `code=true`) and open
 *      the browser (best-effort; the URL is also surfaced to print for the user);
 *   3. read the `code#state` string the user pastes back (`readCode`);
 *   4. split it, verify `state` matches;
 *   5. exchange the code (+ verifier) at the token endpoint via the JSON-body
 *      variant Anthropic's endpoint expects (see `exchangeAuthorizationCodeManual`).
 * No loopback server is ever started for this flow.
 */

import { OAuthError } from "../error.js";
import { createPkcePair, generateState } from "../pkce.js";
import { exchangeAuthorizationCodeManual, defaultFetch } from "../token-endpoint.js";
import type { FetchLike, OAuthProviderConfig, TokenSet } from "../types.js";
import { buildAuthorizeUrl } from "./authcode.js";

export interface ManualCodeFlowOptions {
  /** The provider's real OAuth endpoints (must set `redirectUri`). */
  config: OAuthProviderConfig;
  /** Open the browser at `url`; best-effort, never blocks the paste prompt. */
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  /** Called with the authorize URL so the caller can print it for manual paste. */
  onAuthorizeUrl?: (url: string) => void;
  /** Read the pasted `code#state` string the user copies from the callback page. */
  readCode: () => Promise<string>;
  /** External cancellation. */
  signal?: AbortSignal;
  /** Injected fetch (default global fetch); tests point this at the mock AS. */
  fetchImpl?: FetchLike;
  /** Injected clock (default Date.now). */
  now?: () => number;
}

/** The parsed halves of a pasted `<code>#<state>` string. */
export interface SplitPastedCode {
  code: string;
  state: string;
}

/**
 * Split a pasted `<code>#<state>` string on its FIRST `#`. Missing the
 * separator entirely is treated as a code with no state (which then fails the
 * expected-state check, surfacing a clear `state_mismatch` rather than a
 * confusing parse error).
 */
export function splitPastedCode(pasted: string): SplitPastedCode {
  const trimmed = pasted.trim();
  const hashIdx = trimmed.indexOf("#");
  if (hashIdx === -1) return { code: trimmed, state: "" };
  return { code: trimmed.slice(0, hashIdx).trim(), state: trimmed.slice(hashIdx + 1).trim() };
}

/**
 * Run the full manual-code-paste flow and return the resulting {@link TokenSet}.
 * Rejects with `missing_code` when nothing (or only whitespace) was pasted —
 * e.g. stdin hit EOF with no input — and with `state_mismatch` when the pasted
 * state doesn't match the one minted for this attempt.
 */
export async function runManualCodeFlow(opts: ManualCodeFlowOptions): Promise<TokenSet> {
  const { config } = opts;
  if (!config.redirectUri) {
    throw new OAuthError(
      "invalid_config",
      `provider "${config.id}" has no manual-code redirect_uri configured`,
    );
  }
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const now = opts.now ?? Date.now;
  const pkce = config.usesPkce ? createPkcePair() : null;
  const state = generateState();

  const authorizeUrl = buildAuthorizeUrl(config, {
    redirectUri: config.redirectUri,
    state,
    ...(pkce ? { codeChallenge: pkce.challenge } : {}),
  });

  opts.onAuthorizeUrl?.(authorizeUrl);
  if (opts.openBrowser) {
    try {
      await opts.openBrowser(authorizeUrl);
    } catch {
      // Best-effort — the URL was already surfaced via onAuthorizeUrl for the
      // user to open themselves.
    }
  }

  if (opts.signal?.aborted) {
    throw new OAuthError("cancelled", "login cancelled");
  }

  const pasted = await opts.readCode();
  const { code, state: pastedState } = splitPastedCode(pasted ?? "");
  if (!code) {
    throw new OAuthError("missing_code", "no authorization code entered");
  }
  if (pastedState !== state) {
    throw new OAuthError("state_mismatch", "pasted state does not match the expected value");
  }

  return exchangeAuthorizationCodeManual(
    config,
    {
      code,
      state: pastedState,
      redirectUri: config.redirectUri,
      ...(pkce ? { codeVerifier: pkce.verifier } : {}),
    },
    { fetchImpl, now, ...(opts.signal ? { signal: opts.signal } : {}) },
  );
}
