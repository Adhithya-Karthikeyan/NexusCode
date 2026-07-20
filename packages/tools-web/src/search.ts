/**
 * `web_search` — query a search engine through a pluggable `SearchProvider` seam.
 *
 * The tool never talks to a specific engine directly; it delegates to a
 * `SearchProvider`. Two are shipped:
 *
 *   - `mockSearchProvider` — deterministic, offline. Given a query it derives a
 *     stable set of synthetic results (seeded by the query text), so tests and
 *     air-gapped runs behave identically every time with zero network.
 *   - `createHttpSearchProvider` — a real provider behind an API key, built via a
 *     factory and constructed LAZILY (only when a key is present). It uses native
 *     `fetch` against a Tavily-compatible JSON endpoint; no heavy client library
 *     is a hard dependency. Absent a key, the group falls back to the mock so
 *     `web_search` is always registrable and never crashes.
 *
 * Permission class `network`.
 */

import type { ContentBlock } from "@nexuscode/shared";
import type { Tool, ToolContext, ToolResult } from "@nexuscode/tools";
import { asObject, optNumber, reqString } from "./validate.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Optional relevance score in [0,1] when the provider supplies one. */
  score?: number;
}

export interface SearchQueryOptions {
  /** Desired maximum number of results (provider may return fewer). */
  maxResults?: number;
}

/** The seam every search backend implements. */
export interface SearchProvider {
  /** Human/label name, surfaced in the tool output header. */
  readonly name: string;
  search(query: string, opts: SearchQueryOptions, ctx: ToolContext): Promise<SearchResult[]>;
}

/** FNV-1a 32-bit hash — small, dependency-free, deterministic. */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A deterministic, offline search provider. Results are a pure function of the
 * query string, so the same query always yields the same ranked list — ideal for
 * tests and reproducible runs. Makes NO network request.
 */
export const mockSearchProvider: SearchProvider = {
  name: "mock",
  search(query: string, opts: SearchQueryOptions): Promise<SearchResult[]> {
    const n = Math.max(1, Math.min(20, opts.maxResults ?? 5));
    const slug = query.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "query";
    const results: SearchResult[] = [];
    for (let i = 0; i < n; i++) {
      const seed = fnv1a(`${query}#${i}`);
      const host = `result-${(seed % 900) + 100}.example.com`;
      results.push({
        title: `${query} — result ${i + 1}`,
        url: `https://${host}/${slug}/${i + 1}`,
        snippet: `Deterministic mock result ${i + 1} for "${query}". Seed ${seed.toString(16)}.`,
        score: Number((1 - i / n).toFixed(4)),
      });
    }
    return Promise.resolve(results);
  },
};

export interface HttpSearchProviderOptions {
  apiKey: string;
  /** Tavily-compatible search endpoint. */
  endpoint?: string;
  name?: string;
  timeoutMs?: number;
}

const DEFAULT_SEARCH_ENDPOINT = "https://api.tavily.com/search";
const DEFAULT_SEARCH_TIMEOUT_MS = 15_000;

/**
 * Build a real search provider bound to an API key. Constructed lazily by the
 * factory only when a key exists; it issues one native `fetch` per query to a
 * Tavily-compatible JSON API. The API key travels only in the request body over
 * HTTPS and is never logged. No client library dependency.
 */
export function createHttpSearchProvider(opts: HttpSearchProviderOptions): SearchProvider {
  const endpoint = opts.endpoint ?? DEFAULT_SEARCH_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;
  return {
    name: opts.name ?? "http",
    async search(query: string, queryOpts: SearchQueryOptions, ctx: ToolContext): Promise<SearchResult[]> {
      const ac = new AbortController();
      const onAbort = (): void => ac.abort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal.aborted) ac.abort();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          signal: ac.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: opts.apiKey,
            query,
            max_results: Math.max(1, Math.min(20, queryOpts.maxResults ?? 5)),
          }),
        });
        if (!response.ok) {
          throw new Error(`search API returned HTTP ${response.status}`);
        }
        const data = (await response.json()) as { results?: unknown };
        const rows = Array.isArray(data.results) ? data.results : [];
        const out: SearchResult[] = [];
        for (const row of rows) {
          if (typeof row !== "object" || row === null) continue;
          const r = row as Record<string, unknown>;
          const url = typeof r.url === "string" ? r.url : undefined;
          if (!url) continue;
          const result: SearchResult = {
            title: typeof r.title === "string" ? r.title : url,
            url,
            snippet: typeof r.content === "string" ? r.content : "",
          };
          if (typeof r.score === "number") result.score = r.score;
          out.push(result);
        }
        return out;
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

export interface CreateWebSearchToolOptions {
  /** The provider to delegate to. Defaults to the deterministic mock. */
  provider?: SearchProvider;
  /** Default max results when the caller omits it. */
  defaultMaxResults?: number;
}

/**
 * Resolve the default search provider from the environment: a real HTTP provider
 * when a `TAVILY_API_KEY` / `NEXUSCODE_SEARCH_API_KEY` is present, else the
 * deterministic mock. The key is read here only to decide; it is not logged.
 */
export function resolveDefaultSearchProvider(env: NodeJS.ProcessEnv = process.env): SearchProvider {
  const apiKey = env.NEXUSCODE_SEARCH_API_KEY ?? env.TAVILY_API_KEY;
  if (apiKey && apiKey.length > 0) {
    const providerOpts: HttpSearchProviderOptions = { apiKey };
    if (env.NEXUSCODE_SEARCH_ENDPOINT) providerOpts.endpoint = env.NEXUSCODE_SEARCH_ENDPOINT;
    return createHttpSearchProvider(providerOpts);
  }
  return mockSearchProvider;
}

interface WebSearchInput {
  query: string;
  maxResults?: number;
}

function parseInput(input: unknown): WebSearchInput {
  const o = asObject(input);
  const out: WebSearchInput = { query: reqString(o, "query") };
  const maxResults = optNumber(o, "maxResults");
  if (maxResults !== undefined) out.maxResults = maxResults;
  return out;
}

/**
 * Build a `web_search` tool bound to a provider. Integration passes a real
 * provider (or the mock in tests). With no options it uses the deterministic
 * mock so the tool is always safe to register offline.
 */
export function createWebSearchTool(opts: CreateWebSearchToolOptions = {}): Tool {
  const provider = opts.provider ?? mockSearchProvider;
  const defaultMax = opts.defaultMaxResults ?? 5;
  return {
    name: "web_search",
    description:
      "Search the web for a query and return ranked results (title, URL, snippet). Backed by a pluggable search provider; results are network-sourced (or deterministic in offline/mock mode).",
    permission: "network",
    timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        maxResults: { type: "number", description: `Maximum results to return (default ${defaultMax}).` },
      },
      required: ["query"],
      additionalProperties: false,
    },
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const parsed = parseInput(input);
      const queryOpts: SearchQueryOptions = { maxResults: parsed.maxResults ?? defaultMax };
      try {
        const results = await provider.search(parsed.query, queryOpts, ctx);
        if (results.length === 0) {
          return { ok: true, content: [{ type: "text", text: `No results for "${parsed.query}".` }] };
        }
        const lines: string[] = [`Search results for "${parsed.query}" (${provider.name}):`, ""];
        results.forEach((r, i) => {
          lines.push(`${i + 1}. ${r.title}`);
          lines.push(`   ${r.url}`);
          if (r.snippet) lines.push(`   ${r.snippet.replace(/\s+/g, " ").trim()}`);
        });
        const content: ContentBlock[] = [{ type: "text", text: lines.join("\n") }];
        return { ok: true, content };
      } catch (err) {
        const reason = ctx.signal.aborted
          ? "web_search cancelled"
          : `web_search failed: ${err instanceof Error ? err.message : String(err)}`;
        return { ok: false, content: [{ type: "text", text: reason }], isError: true };
      }
    },
  };
}
