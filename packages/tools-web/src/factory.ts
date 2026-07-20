/**
 * The web tool group factory. Returns a fresh `Tool[]` so integration code can
 * register the whole group into a `ToolRegistry` in one call — mirroring the
 * `builtinTools()` shape of `@nexuscode/tools`.
 */

import type { Tool } from "@nexuscode/tools";
import { webFetchTool } from "./fetch.js";
import { webCrawlTool } from "./crawl.js";
import {
  createWebSearchTool,
  resolveDefaultSearchProvider,
  type SearchProvider,
} from "./search.js";

export interface WebToolsOptions {
  /**
   * Search backend for `web_search`. When omitted, a provider is resolved from
   * the environment (real HTTP provider if a search API key is set, else the
   * deterministic offline mock).
   */
  searchProvider?: SearchProvider;
  /** Default max results for `web_search` when the caller omits it. */
  defaultMaxResults?: number;
}

/**
 * All web tools in a stable order: `[web_search, web_fetch, web_crawl]`.
 * `web_fetch` and `web_crawl` are stateless singletons; `web_search` is bound to
 * a provider (injected, or resolved from the environment).
 */
export function webTools(opts: WebToolsOptions = {}): Tool[] {
  const provider = opts.searchProvider ?? resolveDefaultSearchProvider();
  const searchOpts: Parameters<typeof createWebSearchTool>[0] = { provider };
  if (opts.defaultMaxResults !== undefined) searchOpts.defaultMaxResults = opts.defaultMaxResults;
  const searchTool = createWebSearchTool(searchOpts);
  return [searchTool, webFetchTool, webCrawlTool];
}
