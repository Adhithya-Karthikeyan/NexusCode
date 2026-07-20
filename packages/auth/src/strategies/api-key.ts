/**
 * The `"api-key"` {@link AuthStrategy} — the HONEST path for providers whose API
 * authenticates by key (OpenAI, the OpenAI-compat family, the Anthropic console
 * key). `login()` does NOT pretend to be OAuth: it points the user at the
 * provider's key page (best-effort browser open) and captures the key they
 * paste, storing it securely through the {@link SecretStore} chain (env → OS
 * keychain → encrypted file). `resolveCredential()` reads the key back (env
 * first, then the store) and returns it as an `"api-key"` credential.
 */

import type { SecretStore } from "@nexuscode/config";
import type { AuthStatus, AuthStrategy, LoginStrategyOptions, ResolvedCredential } from "./types.js";

export interface ApiKeyStrategyOptions {
  providerId: string;
  secrets: SecretStore;
  /** SecretStore ref the key is stored under (default = providerId). */
  ref?: string;
  /** Env var checked BEFORE the store when resolving (e.g. `OPENAI_API_KEY`). */
  keyEnv?: string;
  /** The provider's key page, opened (best-effort) to guide the user. */
  keyPageUrl?: string;
  /** Human method label (default `"api-key"`). */
  label?: string;
  /** Best-effort browser opener (default no-op; the CLI injects the real one). */
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  /** Injected env (default `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/** Build an `"api-key"` strategy. */
export function createApiKeyStrategy(opts: ApiKeyStrategyOptions): AuthStrategy {
  const providerId = opts.providerId;
  const ref = opts.ref ?? providerId;
  const label = opts.label ?? "api-key";
  const env = opts.env ?? process.env;

  const readKeyFromEnv = (): string | null => {
    if (!opts.keyEnv) return null;
    const v = env[opts.keyEnv];
    return v && v.length > 0 ? v : null;
  };

  const status = async (): Promise<AuthStatus> => {
    const fromEnv = readKeyFromEnv();
    if (fromEnv) {
      return {
        providerId,
        kind: "api-key",
        loggedIn: true,
        method: label,
        detail: `key present (env ${opts.keyEnv})`,
      };
    }
    const src = await opts.secrets.source(ref);
    if (src) {
      return { providerId, kind: "api-key", loggedIn: true, method: label, detail: `key present (${src})` };
    }
    return {
      providerId,
      kind: "api-key",
      loggedIn: false,
      method: label,
      detail: opts.keyEnv ? `no key (set ${opts.keyEnv} or run login)` : "no key stored",
    };
  };

  const login = async (loginOpts: LoginStrategyOptions = {}): Promise<AuthStatus> => {
    // Guide the user to the key page. The URL is ALWAYS surfaced via
    // `onKeyPage` (the CLI prints it), but the browser is only auto-opened
    // when the caller explicitly opts in (`autoOpenBrowser` — wired from
    // `--open` or a config override): auto-launching a browser to a
    // provider's key page during a plain api-key login is surprising by
    // default, and can land the user on a login wall.
    if (opts.keyPageUrl) {
      loginOpts.onKeyPage?.(opts.keyPageUrl);
      if (loginOpts.autoOpenBrowser) {
        const opener = loginOpts.openBrowser ?? opts.openBrowser;
        if (opener) {
          try {
            await opener(opts.keyPageUrl);
          } catch {
            /* best-effort — the URL was already surfaced via onKeyPage */
          }
        }
      }
    }
    // Capture the key: an explicit value wins, else the lazy reader (TTY prompt).
    let key = loginOpts.apiKey ?? "";
    if (!key && loginOpts.readKey) key = (await loginOpts.readKey()).trim();
    if (!key) {
      throw new Error(
        `${providerId}: no API key provided — paste your key (this is an api-key login, not OAuth)`,
      );
    }
    await opts.secrets.set(ref, key);
    return status();
  };

  const logout = async (): Promise<void> => {
    await opts.secrets.delete(ref);
  };

  const resolveCredential = async (): Promise<ResolvedCredential> => {
    const fromEnv = readKeyFromEnv();
    if (fromEnv) return { kind: "api-key", value: fromEnv };
    const stored = await opts.secrets.get(ref);
    return { kind: "api-key", value: stored ?? "" };
  };

  return {
    providerId,
    kind: "api-key",
    label,
    ...(opts.keyEnv ? { apiKeyEnv: opts.keyEnv } : {}),
    login,
    logout,
    status,
    resolveCredential,
  };
}
