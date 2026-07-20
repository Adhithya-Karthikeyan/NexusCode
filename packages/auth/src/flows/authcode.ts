/**
 * Authorization Code + PKCE flow with a LOOPBACK REDIRECT (the desktop-native
 * pattern, RFC 8252). We:
 *   1. mint a PKCE pair + CSRF `state`;
 *   2. start a throwaway HTTP server on 127.0.0.1:<ephemeral>;
 *   3. build the authorize URL (client_id, redirect_uri, scope, state,
 *      code_challenge) and open the browser (best-effort; the URL is also
 *      surfaced to print for manual paste);
 *   4. capture the redirect callback, validate `state`, read the `code`;
 *   5. exchange the code (+ verifier) at the token endpoint;
 *   6. always tear the server down.
 * Timeout and external `AbortSignal` cancellation are both honored.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { OAuthError } from "../error.js";
import { createPkcePair, generateState } from "../pkce.js";
import { exchangeAuthorizationCode, defaultFetch } from "../token-endpoint.js";
import type { FetchLike, OAuthProviderConfig, TokenSet } from "../types.js";

export interface AuthCodeFlowOptions {
  /** The provider's real OAuth endpoints. */
  config: OAuthProviderConfig;
  /** Open the browser at `url`; return whether a launcher was spawned. */
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  /** Called with the authorize URL so the caller can print it for manual paste. */
  onAuthorizeUrl?: (url: string) => void;
  /** Overall wait budget for the browser round-trip (default 300_000 ms). */
  timeoutMs?: number;
  /** External cancellation. */
  signal?: AbortSignal;
  /** Loopback host (default 127.0.0.1). */
  redirectHost?: string;
  /** Loopback port; 0 (default) picks an ephemeral free port. */
  redirectPort?: number;
  /** Callback path (default /callback). */
  redirectPath?: string;
  /** Injected fetch (default global fetch); tests point this at the mock AS. */
  fetchImpl?: FetchLike;
  /** Injected clock (default Date.now). */
  now?: () => number;
}

const SUCCESS_HTML =
  "<!doctype html><meta charset=utf-8><title>NexusCode</title>" +
  "<body style=\"font-family:system-ui;padding:3rem;text-align:center\">" +
  "<h2>Login complete</h2><p>You can close this window and return to your terminal.</p></body>";

// Fixed, generic markup for every failure branch — deliberately NEVER
// interpolates any request-derived value (provider `error`/`error_description`,
// path, etc). The loopback callback page is served on the user's own machine
// but is reachable by any local process/page that can guess the ephemeral
// port, so reflecting attacker- or provider-supplied strings into HTML here
// would be a same-origin XSS on that page. The real reason still travels
// out-of-band via the thrown `OAuthError` seen by the calling process.
const FAILURE_HTML =
  "<!doctype html><meta charset=utf-8><title>NexusCode</title>" +
  "<body style=\"font-family:system-ui;padding:3rem;text-align:center\">" +
  "<h2>Login failed</h2><p>Return to your terminal to see what happened.</p></body>";

function respond(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      if (addr && typeof addr === "object") resolve((addr as AddressInfo).port);
      else reject(new OAuthError("network_error", "failed to bind loopback redirect server"));
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/**
 * Build the RFC 6749 authorize URL for this attempt. `config.extraAuthorizeParams`
 * (e.g. Anthropic's `code=true`, which tells its authorize endpoint to render the
 * code on the callback page rather than attempt a redirect) is applied FIRST so
 * the standard params below always win on any key collision. The remaining
 * params are set in the SAME order Claude Code's own CLI (and the verified
 * ClaudeGauge `OAuthService.swift` `beginLogin`) build them: client_id,
 * response_type, redirect_uri, scope, code_challenge(+method), state.
 */
export function buildAuthorizeUrl(
  config: OAuthProviderConfig,
  args: { redirectUri: string; state: string; codeChallenge?: string },
): string {
  const u = new URL(config.authorizeUrl);
  if (config.extraAuthorizeParams) {
    for (const [k, v] of Object.entries(config.extraAuthorizeParams)) {
      u.searchParams.set(k, v);
    }
  }
  u.searchParams.set("client_id", config.clientId);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("redirect_uri", args.redirectUri);
  u.searchParams.set("scope", config.scopes.join(" "));
  if (config.usesPkce && args.codeChallenge) {
    u.searchParams.set("code_challenge", args.codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
  }
  u.searchParams.set("state", args.state);
  if (config.audience) u.searchParams.set("audience", config.audience);
  return u.toString();
}

/**
 * Wait for the loopback redirect and resolve the captured authorization code.
 * Rejects on a provider-returned `error` (with a matching `state`), timeout, or
 * abort.
 *
 * A single stray/malicious request MUST NOT be able to cancel an in-progress
 * login: the ephemeral loopback port can be guessed and hit by any other local
 * process, or by a malicious web page (e.g. `fetch("http://127.0.0.1:<port>/…")`).
 * So a request with the wrong path, a `state` that doesn't match, or a missing
 * `code` with no `error` param is answered 400 but does NOT settle this
 * promise — the server keeps listening for the genuine callback until the
 * timeout or an external abort fires. Only a request whose `state` matches can
 * settle the flow (by resolving with a `code`, or rejecting on a provider
 * `error`).
 */
function waitForCallback(
  server: Server,
  expectedState: string,
  redirectPath: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;

    const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const state = url.searchParams.get("state");

      if (url.pathname !== redirectPath || state !== expectedState) {
        // Wrong path or a state mismatch: could be a stray local request or a
        // forged callback guessing the ephemeral port. Reject THIS request
        // only — keep waiting for the genuine callback rather than tearing
        // down a legitimate in-progress login.
        respond(res, 400, FAILURE_HTML);
        return;
      }

      const err = url.searchParams.get("error");
      if (err) {
        const desc = url.searchParams.get("error_description") ?? undefined;
        respond(res, 400, FAILURE_HTML);
        finish(() => reject(new OAuthError(err, `authorization endpoint returned "${err}"`, desc)));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        // Matching state but no code and no error: malformed callback. Wait
        // for the genuine one instead of aborting the flow.
        respond(res, 400, FAILURE_HTML);
        return;
      }

      respond(res, 200, SUCCESS_HTML);
      finish(() => resolve(code));
    };

    const timer = setTimeout(() => {
      finish(() =>
        reject(new OAuthError("timeout", `login timed out after ${timeoutMs}ms with no redirect`)),
      );
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const onAbort = (): void => {
      finish(() => reject(new OAuthError("cancelled", "login cancelled")));
    };

    const cleanup = (): void => {
      clearTimeout(timer);
      server.removeListener("request", onRequest);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    function finish(action: () => void): void {
      if (settled) return;
      settled = true;
      cleanup();
      action();
    }

    server.on("request", onRequest);
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort);
    }
  });
}

/**
 * Run the full Authorization Code + PKCE loopback flow and return the resulting
 * {@link TokenSet}. The temporary redirect server is always closed before
 * returning (success or failure).
 */
export async function runAuthorizationCodeFlow(opts: AuthCodeFlowOptions): Promise<TokenSet> {
  const { config } = opts;
  const host = opts.redirectHost ?? "127.0.0.1";
  const redirectPath = opts.redirectPath ?? "/callback";
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const now = opts.now ?? Date.now;

  const pkce = config.usesPkce ? createPkcePair() : null;
  const state = generateState();

  const server = createServer();
  const actualPort = await listen(server, host, opts.redirectPort ?? 0);
  const redirectUri = `http://${host}:${actualPort}${redirectPath}`;

  try {
    const authorizeUrl = buildAuthorizeUrl(config, {
      redirectUri,
      state,
      ...(pkce ? { codeChallenge: pkce.challenge } : {}),
    });

    // Attach the callback listener BEFORE opening the browser: the redirect can
    // arrive the instant the browser navigates, so the server must already be
    // listening for it (otherwise an eager opener that completes the round-trip
    // would deadlock against a server with no request handler).
    const callback = waitForCallback(server, state, redirectPath, timeoutMs, opts.signal);

    opts.onAuthorizeUrl?.(authorizeUrl);
    // Fire the opener (best-effort, non-fatal) but do NOT block the callback await
    // on it: an eager in-process opener can settle the callback synchronously, and
    // awaiting the opener first would leave that (possibly rejected) callback
    // promise momentarily unhandled.
    const opened: Promise<unknown> = opts.openBrowser
      ? Promise.resolve()
          .then(() => opts.openBrowser?.(authorizeUrl))
          .catch(() => false)
      : Promise.resolve(false);

    const code = await callback;
    await opened;

    return await exchangeAuthorizationCode(
      config,
      { code, redirectUri, ...(pkce ? { codeVerifier: pkce.verifier } : {}) },
      { fetchImpl, now, ...(opts.signal ? { signal: opts.signal } : {}) },
    );
  } finally {
    await closeServer(server);
  }
}
