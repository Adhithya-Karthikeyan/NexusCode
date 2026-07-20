/**
 * The gateway rewrite: pure functions over the provider `baseURL`/headers seam.
 * Nothing here imports an adapter or `@nexuscode/config` — {@link applyGateway}
 * takes a plain config-shaped object and returns a rewritten clone, so the CLI
 * (or SDK/daemon) can apply it wherever it assembles provider configs.
 */

import type {
  GatewayConfig,
  GatewayableProviderConfig,
  GatewaySet,
} from "./types.js";
import { GatewayEgressError } from "./types.js";

/**
 * Header names (case-insensitive) that carry a VENDOR credential rather than
 * gateway-routing metadata. Stripped from the PROVIDER's own headers by
 * {@link applyGateway} (default `stripProviderAuth: true`) before merging with
 * the gateway's own headers, so a vendor API key is never forwarded to the
 * corporate gateway host just because the provider config happened to carry
 * it as a static header.
 */
const PROVIDER_AUTH_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);

/** Lower-cased hostname of a URL, or `undefined` if it can't be parsed. */
export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * True when `url`'s host is permitted by `allowlist`. An empty/undefined
 * allowlist permits everything (no egress restriction configured). A URL that
 * cannot be parsed is NOT permitted when a non-empty allowlist is set
 * (fail closed). Allowlist entries match the host exactly (case-insensitive) or
 * as a dot-suffix (`corp.example.com` allows `gw.corp.example.com`).
 */
export function isEgressAllowed(url: string, allowlist?: readonly string[]): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  const host = hostOf(url);
  if (host === undefined) return false;
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return host === e || host.endsWith(`.${e}`);
  });
}

/**
 * Rewrite a provider config so ALL of its calls route through `gateway`:
 * overrides the endpoint (`baseUrl`/`baseURL`, whichever the config uses — both
 * when both are present) and merges the gateway headers into the config's own
 * (`headers`/`defaultHeaders`). The input is never mutated — a shallow clone is
 * returned.
 *
 * Fails closed: if the gateway declares a non-empty `egressAllowlist` and its
 * own `baseUrl` host is not on it, throws {@link GatewayEgressError} instead of
 * routing traffic off-allowlist.
 *
 * By default (`stripProviderAuth: true`), the PROVIDER's own vendor-credential
 * headers (`authorization`, `x-api-key`, `api-key`) are dropped before the
 * merge — the gateway injects its OWN auth, and a vendor API key has no
 * business reaching the corporate gateway host. Use `allowProviderHeaders` to
 * exempt a specific header, or `stripProviderAuth: false` to keep the old
 * pass-everything-through behavior.
 */
export function applyGateway<T extends GatewayableProviderConfig>(
  config: T,
  gateway: GatewayConfig,
): T {
  if (!isEgressAllowed(gateway.baseUrl, gateway.egressAllowlist)) {
    throw new GatewayEgressError(
      hostOf(gateway.baseUrl) ?? gateway.baseUrl,
      gateway.egressAllowlist ?? [],
    );
  }

  const gwHeaders = gateway.headers ?? {};
  const override = gateway.overrideProviderHeaders ?? true;
  const stripProviderAuth = gateway.stripProviderAuth ?? true;
  const allowedProviderHeaders = new Set(
    (gateway.allowProviderHeaders ?? []).map((h) => h.toLowerCase()),
  );

  const out: T = { ...config };

  // Rewrite whichever endpoint key(s) the config carries; when it carries none,
  // establish the config-schema `baseUrl` so the endpoint is still overridden.
  const hasCamel = "baseURL" in config;
  const hasLower = "baseUrl" in config;
  if (hasCamel) (out as GatewayableProviderConfig).baseURL = gateway.baseUrl;
  if (hasLower) (out as GatewayableProviderConfig).baseUrl = gateway.baseUrl;
  if (!hasCamel && !hasLower) (out as GatewayableProviderConfig).baseUrl = gateway.baseUrl;

  // Drop the provider's own vendor-credential headers (unless explicitly
  // allowlisted) before merging with the gateway's headers.
  const sanitizeProviderHeaders = (
    existing: Record<string, string> | undefined,
  ): Record<string, string> | undefined => {
    if (!existing || !stripProviderAuth) return existing;
    const safe: Record<string, string> = {};
    for (const [k, v] of Object.entries(existing)) {
      const lower = k.toLowerCase();
      if (PROVIDER_AUTH_HEADERS.has(lower) && !allowedProviderHeaders.has(lower)) continue;
      safe[k] = v;
    }
    return safe;
  };

  // Merge headers into whichever header key(s) the config carries; default to
  // the config-schema `headers` key when the config has none.
  const mergeInto = (existing: Record<string, string> | undefined): Record<string, string> => {
    const safe = sanitizeProviderHeaders(existing);
    return override ? { ...(safe ?? {}), ...gwHeaders } : { ...gwHeaders, ...(safe ?? {}) };
  };

  const hasHeaders = "headers" in config;
  const hasDefaultHeaders = "defaultHeaders" in config;
  if (hasHeaders) (out as GatewayableProviderConfig).headers = mergeInto(config.headers);
  if (hasDefaultHeaders)
    (out as GatewayableProviderConfig).defaultHeaders = mergeInto(config.defaultHeaders);
  if (!hasHeaders && !hasDefaultHeaders)
    (out as GatewayableProviderConfig).headers = mergeInto(undefined);

  return out;
}

/**
 * Resolve the gateway that governs `providerId` from a {@link GatewaySet}: a
 * per-provider entry wins over the global default; `undefined` when neither is
 * configured (the provider talks to its vendor directly).
 */
export function resolveGateway(providerId: string, set: GatewaySet): GatewayConfig | undefined {
  return set.byProvider?.[providerId] ?? set.global;
}

/**
 * Convenience over {@link resolveGateway} + {@link applyGateway}: rewrite a
 * provider config using whichever gateway (per-provider or global) applies to
 * it. Returns the config unchanged when no gateway governs the provider. The
 * provider id is taken from `config.id` unless `providerId` is given.
 */
export function applyGatewaySet<T extends GatewayableProviderConfig>(
  config: T,
  set: GatewaySet,
  providerId?: string,
): T {
  const id = providerId ?? config.id;
  if (id === undefined) {
    // No id to key a per-provider entry: only a global gateway can apply.
    return set.global ? applyGateway(config, set.global) : config;
  }
  const gw = resolveGateway(id, set);
  return gw ? applyGateway(config, gw) : config;
}
