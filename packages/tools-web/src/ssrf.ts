/**
 * SSRF guard for the web tool group — re-exported from `@nexuscode/tools`,
 * which now owns the single shared implementation used by BOTH `tools-web`
 * (`web_fetch`/`web_crawl`) and `tools-browser` (`browser_navigate`), so the
 * private-IP/DNS-rebinding classification logic is not duplicated across the
 * two packages. This file exists only to preserve `tools-web`'s existing
 * `./ssrf.js` import surface (consumed by `http.ts`, `fetch.ts`, `crawl.ts`,
 * and this package's public `index.ts`) — see `@nexuscode/tools/src/ssrf.ts`
 * for the guard itself and its docs.
 */
export {
  assertAllowedUrl,
  BlockedUrlError,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateHostname,
  expandIPv6,
} from "@nexuscode/tools";
export type { SsrfOptions } from "@nexuscode/tools";
