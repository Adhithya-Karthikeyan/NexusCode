/**
 * @nexuscode/tools-web — the web tool group (system-spec §6, Web: search/fetch/crawl).
 *
 * Three tools implementing the `@nexuscode/tools` Tool contract, all permission
 * class `network`:
 *   - `web_search` — pluggable `SearchProvider` seam (deterministic mock +
 *     lazy real HTTP provider behind an API key).
 *   - `web_fetch`  — native fetch + HTML→text extraction, with a wall-clock
 *     timeout, a streamed response byte cap, and an SSRF guard that blocks
 *     loopback/private/link-local targets by default.
 *   - `web_crawl`  — bounded same-origin breadth-first crawl reusing web_fetch.
 *
 * `webTools()` returns the group as a `Tool[]` for one-call registration.
 */

export { webTools } from "./factory.js";
export type { WebToolsOptions } from "./factory.js";

export { webFetchTool } from "./fetch.js";
export { webCrawlTool, DEFAULT_MAX_PAGES, DEFAULT_MAX_DEPTH, HARD_MAX_PAGES } from "./crawl.js";

export {
  createWebSearchTool,
  createHttpSearchProvider,
  resolveDefaultSearchProvider,
  mockSearchProvider,
} from "./search.js";
export type {
  SearchProvider,
  SearchResult,
  SearchQueryOptions,
  HttpSearchProviderOptions,
  CreateWebSearchToolOptions,
} from "./search.js";

export {
  fetchPage,
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_USER_AGENT,
  MAX_REDIRECTS,
} from "./http.js";
export type { FetchOptions, FetchedPage } from "./http.js";

export {
  assertAllowedUrl,
  BlockedUrlError,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateHostname,
} from "./ssrf.js";
export type { SsrfOptions } from "./ssrf.js";

export { extractText, extractLinks, extractTitle, decodeEntities } from "./html.js";
export type { ExtractedDocument } from "./html.js";
