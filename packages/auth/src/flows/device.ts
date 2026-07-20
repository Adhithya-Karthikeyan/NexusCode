/**
 * Device Authorization Grant (RFC 8628) — the HEADLESS fallback. No browser or
 * loopback server on this machine: we request a `device_code` + `user_code`,
 * surface the verification URL and code for the user to open on ANY device, then
 * poll the token endpoint until the user approves (or it expires / is denied).
 * Honors the server-provided `interval`, backs off on `slow_down`, and respects
 * both the grant's `expires_in` and an external `AbortSignal`.
 */

import { OAuthError } from "../error.js";
import { postForm, defaultFetch } from "../token-endpoint.js";
import { tokenSetFromBody } from "../tokenset.js";
import type { FetchLike, OAuthProviderConfig, TokenSet } from "../types.js";

/** The device-authorization response the user acts on. */
export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

interface DeviceAuthBody {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_url?: string;
  verification_uri_complete?: string;
  expires_in?: number | string;
  interval?: number | string;
  error?: string;
  error_description?: string;
}

export interface DeviceCodeFlowOptions {
  config: OAuthProviderConfig;
  /** Called once with the code + URL the user must open to approve. */
  onPrompt?: (auth: DeviceAuthorization) => void;
  /** External cancellation. */
  signal?: AbortSignal;
  /** Injected fetch (default global fetch); tests point this at the mock AS. */
  fetchImpl?: FetchLike;
  /** Injected clock (default Date.now). */
  now?: () => number;
  /** Injected sleep (default real timer); tests pass a no-wait stub. */
  sleep?: (ms: number) => Promise<void>;
}

function toInt(v: number | string | undefined, dflt: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Request a device + user code from the provider's device endpoint. */
export async function requestDeviceAuthorization(
  config: OAuthProviderConfig,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<DeviceAuthorization> {
  if (!config.deviceEndpoint) {
    throw new OAuthError("no_device_endpoint", `provider "${config.id}" has no device endpoint`);
  }
  const params: Record<string, string> = {
    client_id: config.clientId,
    scope: config.scopes.join(" "),
  };
  const res = await postForm(config.deviceEndpoint, params, fetchImpl, signal);
  const body = res.body as DeviceAuthBody;
  if (!res.ok || body.error) {
    throw new OAuthError(
      body.error ?? "token_endpoint_error",
      `device authorization failed (HTTP ${res.status})`,
      body.error_description,
    );
  }
  if (!body.device_code || !body.user_code) {
    throw new OAuthError("token_endpoint_error", "device endpoint returned no device/user code");
  }
  const auth: DeviceAuthorization = {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri ?? body.verification_url ?? "",
    expiresIn: toInt(body.expires_in, 900),
    interval: Math.max(1, toInt(body.interval, 5)),
  };
  if (body.verification_uri_complete) auth.verificationUriComplete = body.verification_uri_complete;
  return auth;
}

/**
 * Run the full device-code flow: request the codes, prompt the user, then poll
 * the token endpoint to success. Resolves with the {@link TokenSet} once the
 * user approves; rejects on denial, expiry, timeout, or abort.
 */
export async function runDeviceCodeFlow(opts: DeviceCodeFlowOptions): Promise<TokenSet> {
  const { config } = opts;
  const fetchImpl = opts.fetchImpl ?? defaultFetch();
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;

  const auth = await requestDeviceAuthorization(config, fetchImpl, opts.signal);
  opts.onPrompt?.(auth);

  const deadline = now() + auth.expiresIn * 1000;
  let interval = auth.interval;

  for (;;) {
    if (opts.signal?.aborted) {
      throw new OAuthError("cancelled", "device login cancelled");
    }
    if (now() >= deadline) {
      throw new OAuthError("expired_token", "device code expired before approval");
    }

    await sleep(interval * 1000);

    if (opts.signal?.aborted) {
      throw new OAuthError("cancelled", "device login cancelled");
    }

    const params: Record<string, string> = {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: auth.deviceCode,
      client_id: config.clientId,
    };
    if (config.clientSecret) params.client_secret = config.clientSecret;

    const res = await postForm(config.tokenEndpoint, params, fetchImpl, opts.signal);

    if (res.ok && res.body.access_token) {
      return tokenSetFromBody(res.body, now(), config.scopes.join(" "));
    }

    const err = res.body.error;
    if (err === "authorization_pending") {
      continue; // keep polling at the current interval
    }
    if (err === "slow_down") {
      interval += 5; // RFC 8628 §3.5: back off by 5s
      continue;
    }
    // access_denied, expired_token, invalid_grant, or anything else → terminal.
    throw new OAuthError(
      err ?? "token_endpoint_error",
      `device token polling failed: ${err ?? `HTTP ${res.status}`}`,
      res.body.error_description,
    );
  }
}
