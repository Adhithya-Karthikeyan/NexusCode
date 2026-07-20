/**
 * Private model gateways (system-spec §25) — routing provider traffic through a
 * corporate proxy/gateway.
 *
 * An enterprise deployment frequently forbids adapters from talking to a model
 * vendor directly: every call must egress through a company-run gateway that
 * terminates TLS, injects a signed org token, and enforces an allowlist. This
 * module expresses that policy as data ({@link GatewayConfig}) and a pure
 * rewrite ({@link applyGateway}) over the *existing* provider `baseURL`/headers
 * seam — it never rewrites an adapter. Point an adapter's config at the gateway
 * and all of that provider's calls flow through it.
 */

/**
 * A corporate gateway endpoint. Overriding a provider's `baseURL` to this value
 * and merging {@link headers} is enough to funnel every call for that provider
 * through the proxy — the adapter already threads its configured baseURL/headers
 * into the underlying SDK/transport (the frozen provider seam).
 */
export interface GatewayConfig {
  /** Gateway base URL that REPLACES the provider's own endpoint. */
  baseUrl: string;
  /**
   * Static headers injected into every request routed through the gateway —
   * e.g. `{ "x-org-id": "acme", "authorization": "Bearer <gw-token>" }`. Merged
   * over the provider's own headers (gateway wins on a key clash unless
   * {@link overrideProviderHeaders} is false).
   */
  headers?: Record<string, string>;
  /** Gateway wins on a header-key clash. Default true. */
  overrideProviderHeaders?: boolean;
  /**
   * Optional egress allowlist of hostnames the gateway itself is permitted to
   * be. Because ALL provider traffic is rewritten to {@link baseUrl}, the
   * effective egress target is the gateway host; when this list is non-empty and
   * the gateway host is not on it, {@link applyGateway} FAILS CLOSED (throws
   * {@link GatewayEgressError}) rather than silently routing off-allowlist.
   */
  egressAllowlist?: string[];
  /**
   * Drop the PROVIDER's own vendor-credential headers (`authorization`,
   * `x-api-key`, `api-key`, case-insensitive) before merging with the
   * gateway's headers, so a vendor API key is never forwarded to the
   * corporate gateway host unnecessarily. Default **true**. An entry in
   * {@link allowProviderHeaders} is exempted even when this is on.
   */
  stripProviderAuth?: boolean;
  /**
   * Provider header names (case-insensitive) to keep even when
   * {@link stripProviderAuth} is on — an explicit allowlist for a header the
   * gateway is meant to see verbatim.
   */
  allowProviderHeaders?: string[];
}

/**
 * A set of gateways: one optional {@link GatewayConfig.global} default plus
 * per-provider overrides. Resolution ({@link resolveGateway}) prefers a
 * provider-specific entry over the global one, so an org can push most providers
 * through a shared proxy while a regulated provider gets its own.
 */
export interface GatewaySet {
  /** Applied to every provider unless a per-provider entry overrides it. */
  global?: GatewayConfig;
  /** provider id → gateway. Wins over {@link global}. */
  byProvider?: Record<string, GatewayConfig>;
}

/**
 * The subset of a provider config the gateway rewrites. Both the config-schema
 * casing (`baseUrl`, `headers`) and the adapter-config casing (`baseURL`,
 * `defaultHeaders`) are accepted so {@link applyGateway} works over either seam
 * without importing `@nexuscode/config` or a concrete adapter.
 */
export interface GatewayableProviderConfig {
  /** Provider id — used by {@link resolveGateway} to pick a per-provider entry. */
  id?: string;
  /** Config-schema endpoint key (`@nexuscode/config` `ProviderConfig`). */
  baseUrl?: string;
  /** Adapter-config endpoint key (`OpenAICompatConfig`, anthropic config). */
  baseURL?: string;
  /** Config-schema static headers key. */
  headers?: Record<string, string>;
  /** Adapter-config static headers key. */
  defaultHeaders?: Record<string, string>;
}

/** Thrown when a gateway would egress to a host not on its allowlist. */
export class GatewayEgressError extends Error {
  readonly host: string;
  readonly allowlist: readonly string[];
  constructor(host: string, allowlist: readonly string[]) {
    super(
      `gateway egress to "${host}" is not permitted by the allowlist [${allowlist.join(", ")}]`,
    );
    this.name = "GatewayEgressError";
    this.host = host;
    this.allowlist = allowlist;
  }
}
