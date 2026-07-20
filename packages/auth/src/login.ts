/**
 * `login` — the high-level convenience that picks the right REAL flow and
 * persists the result. Default is the browser Authorization Code + PKCE loopback
 * flow; `mode: "device"` (or `mode: "auto"` on a headless box where the browser
 * cannot open AND a device endpoint exists) uses the Device Authorization Grant;
 * `config.manualCode` (Anthropic's "login like Claude Code") uses the
 * manual-code-paste flow instead of the loopback server, unless `--device` was
 * explicitly requested. The resulting TokenSet is written to the
 * {@link TokenStore} and returned; it is never printed by this function.
 */

import { runAuthorizationCodeFlow, type AuthCodeFlowOptions } from "./flows/authcode.js";
import { runDeviceCodeFlow, type DeviceCodeFlowOptions } from "./flows/device.js";
import { runManualCodeFlow, type ManualCodeFlowOptions } from "./flows/manual-code.js";
import { openBrowser as defaultOpenBrowser } from "./browser.js";
import { OAuthError } from "./error.js";
import type { TokenStore } from "./store.js";
import type { FetchLike, OAuthProviderConfig, TokenSet } from "./types.js";
import type { DeviceAuthorization } from "./flows/device.js";

export type LoginMode = "browser" | "device" | "auto";

export interface LoginOptions {
  config: OAuthProviderConfig;
  store: TokenStore;
  /** Which flow to use (default "browser"). */
  mode?: LoginMode;
  /** Surface the browser authorize URL (printed for manual paste). */
  onAuthorizeUrl?: (url: string) => void;
  /** Surface the device code + verification URL (headless flow). */
  onDevicePrompt?: (auth: DeviceAuthorization) => void;
  /** Override the browser opener (default platform launcher). */
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  /** `config.manualCode` providers only: read the pasted `code#state` string. */
  readCode?: () => Promise<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Run the appropriate OAuth flow, persist the tokens, and return them. */
export async function login(opts: LoginOptions): Promise<TokenSet> {
  const mode = opts.mode ?? "browser";
  const useDevice =
    mode === "device" || (mode === "auto" && Boolean(opts.config.deviceEndpoint));

  let tokens: TokenSet;
  if (useDevice) {
    if (!opts.config.deviceEndpoint) {
      throw new OAuthError(
        "no_device_endpoint",
        `provider "${opts.config.id}" does not support the device-code flow`,
      );
    }
    const dOpts: DeviceCodeFlowOptions = { config: opts.config };
    if (opts.onDevicePrompt) dOpts.onPrompt = opts.onDevicePrompt;
    if (opts.signal) dOpts.signal = opts.signal;
    if (opts.fetchImpl) dOpts.fetchImpl = opts.fetchImpl;
    if (opts.now) dOpts.now = opts.now;
    if (opts.sleep) dOpts.sleep = opts.sleep;
    tokens = await runDeviceCodeFlow(dOpts);
  } else if (opts.config.manualCode) {
    const mOpts: ManualCodeFlowOptions = {
      config: opts.config,
      openBrowser: opts.openBrowser ?? ((url: string) => defaultOpenBrowser(url)),
      readCode: opts.readCode ?? ((): Promise<string> => Promise.resolve("")),
    };
    if (opts.onAuthorizeUrl) mOpts.onAuthorizeUrl = opts.onAuthorizeUrl;
    if (opts.signal) mOpts.signal = opts.signal;
    if (opts.fetchImpl) mOpts.fetchImpl = opts.fetchImpl;
    if (opts.now) mOpts.now = opts.now;
    tokens = await runManualCodeFlow(mOpts);
  } else {
    const aOpts: AuthCodeFlowOptions = {
      config: opts.config,
      openBrowser: opts.openBrowser ?? ((url: string) => defaultOpenBrowser(url)),
    };
    if (opts.onAuthorizeUrl) aOpts.onAuthorizeUrl = opts.onAuthorizeUrl;
    if (opts.signal) aOpts.signal = opts.signal;
    if (opts.timeoutMs !== undefined) aOpts.timeoutMs = opts.timeoutMs;
    if (opts.fetchImpl) aOpts.fetchImpl = opts.fetchImpl;
    if (opts.now) aOpts.now = opts.now;
    tokens = await runAuthorizationCodeFlow(aOpts);
  }

  await opts.store.set(opts.config.id, tokens);
  return tokens;
}

/** Remove a provider's stored tokens (the `logout` primitive). */
export async function logout(store: TokenStore, providerId: string): Promise<void> {
  await store.clear(providerId);
}
