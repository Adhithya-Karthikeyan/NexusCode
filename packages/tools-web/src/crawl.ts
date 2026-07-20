/**
 * `web_crawl` — a bounded breadth-first crawl rooted at a start URL.
 *
 * Reuses `web_fetch`'s SSRF-guarded fetch+extract core (`fetchPage`) per page.
 * Hard bounds keep it from running away: `maxPages` (total pages fetched),
 * `maxDepth` (link hops from the seed), and same-origin confinement (on by
 * default — only links sharing the seed's origin are enqueued). Each URL is
 * visited at most once. Individual page failures (blocked link, network error)
 * are recorded and skipped; they never abort the whole crawl. Permission class
 * `network`. Returns a `ToolResult` — never throws for a per-page failure.
 */

import type { ContentBlock } from "@nexuscode/shared";
import type { Tool, ToolContext, ToolResult } from "@nexuscode/tools";
import { BlockedUrlError } from "./ssrf.js";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_BYTES,
  fetchPage,
  type FetchOptions,
} from "./http.js";
import { asObject, optBool, optNumber, optString, reqString } from "./validate.js";

export const DEFAULT_MAX_PAGES = 10;
export const DEFAULT_MAX_DEPTH = 2;
/** Absolute ceiling on pages regardless of caller input — a safety backstop. */
export const HARD_MAX_PAGES = 200;
/** Per-page text kept in the crawl summary (chars). Full text is not accumulated. */
const SNIPPET_CHARS = 500;

interface WebCrawlInput {
  url: string;
  maxPages: number;
  maxDepth: number;
  sameOrigin: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  allowPrivateHosts?: boolean;
  userAgent?: string;
}

function parseInput(input: unknown): WebCrawlInput {
  const o = asObject(input);
  const rawMaxPages = optNumber(o, "maxPages") ?? DEFAULT_MAX_PAGES;
  const maxPages = Math.max(1, Math.min(HARD_MAX_PAGES, Math.floor(rawMaxPages)));
  const maxDepth = Math.max(0, Math.floor(optNumber(o, "maxDepth") ?? DEFAULT_MAX_DEPTH));
  const sameOrigin = optBool(o, "sameOrigin") ?? true;
  const out: WebCrawlInput = { url: reqString(o, "url"), maxPages, maxDepth, sameOrigin };
  const maxBytes = optNumber(o, "maxBytes");
  const timeoutMs = optNumber(o, "timeoutMs");
  const allowPrivateHosts = optBool(o, "allowPrivateHosts");
  const userAgent = optString(o, "userAgent");
  if (maxBytes !== undefined) out.maxBytes = maxBytes;
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  if (allowPrivateHosts !== undefined) out.allowPrivateHosts = allowPrivateHosts;
  if (userAgent !== undefined) out.userAgent = userAgent;
  return out;
}

function toFetchOptions(i: WebCrawlInput): FetchOptions {
  const opts: FetchOptions = {};
  if (i.maxBytes !== undefined) opts.maxBytes = i.maxBytes;
  if (i.timeoutMs !== undefined) opts.timeoutMs = i.timeoutMs;
  if (i.allowPrivateHosts !== undefined) opts.allowPrivate = i.allowPrivateHosts;
  if (i.userAgent !== undefined) opts.userAgent = i.userAgent;
  return opts;
}

interface CrawlNode {
  url: string;
  depth: number;
}

interface PageRecord {
  url: string;
  depth: number;
  status: number;
  title: string | undefined;
  snippet: string;
  error?: string;
}

function normalizeForVisit(rawUrl: string): string | undefined {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
}

async function runWebCrawl(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = parseInput(input);
  const seed = normalizeForVisit(parsed.url);
  if (seed === undefined) {
    return { ok: false, content: [{ type: "text", text: `web_crawl: invalid start URL: ${parsed.url}` }], isError: true };
  }
  let seedOrigin: string;
  try {
    seedOrigin = new URL(seed).origin;
  } catch {
    return { ok: false, content: [{ type: "text", text: `web_crawl: invalid start URL: ${parsed.url}` }], isError: true };
  }

  const fetchOpts = toFetchOptions(parsed);
  const visited = new Set<string>([seed]);
  const queue: CrawlNode[] = [{ url: seed, depth: 0 }];
  const records: PageRecord[] = [];

  while (queue.length > 0 && records.length < parsed.maxPages) {
    if (ctx.signal.aborted) break;
    const node = queue.shift();
    if (!node) break;

    try {
      const page = await fetchPage(node.url, fetchOpts, ctx.signal);
      records.push({
        url: node.url,
        depth: node.depth,
        status: page.status,
        title: page.title,
        snippet: page.text.slice(0, SNIPPET_CHARS),
      });

      if (node.depth < parsed.maxDepth) {
        for (const link of page.links) {
          const norm = normalizeForVisit(link);
          if (norm === undefined || visited.has(norm)) continue;
          if (parsed.sameOrigin) {
            let sameOrigin = false;
            try {
              sameOrigin = new URL(norm).origin === seedOrigin;
            } catch {
              sameOrigin = false;
            }
            if (!sameOrigin) continue;
          }
          visited.add(norm);
          queue.push({ url: norm, depth: node.depth + 1 });
        }
      }
    } catch (err) {
      const error =
        err instanceof BlockedUrlError
          ? `blocked: ${err.message}`
          : `error: ${err instanceof Error ? err.message : String(err)}`;
      records.push({ url: node.url, depth: node.depth, status: 0, title: undefined, snippet: "", error });
    }
  }

  const lines: string[] = [
    `Crawled ${records.length} page(s) from ${seed}`,
    `(maxPages=${parsed.maxPages}, maxDepth=${parsed.maxDepth}, sameOrigin=${parsed.sameOrigin})`,
    "",
  ];
  for (const r of records) {
    lines.push(`- [depth ${r.depth}] ${r.url}`);
    if (r.error) {
      lines.push(`  ${r.error}`);
    } else {
      lines.push(`  status ${r.status}${r.title ? ` — ${r.title}` : ""}`);
      if (r.snippet) lines.push(`  ${r.snippet.replace(/\n+/g, " ").trim()}`);
    }
  }
  const content: ContentBlock[] = [{ type: "text", text: lines.join("\n") }];
  const anySuccess = records.some((r) => !r.error);
  return anySuccess ? { ok: true, content } : { ok: false, content, isError: true };
}

export const webCrawlTool: Tool = {
  name: "web_crawl",
  description:
    "Bounded breadth-first crawl from a seed URL, reusing web_fetch per page. Bounded by maxPages, maxDepth, and same-origin confinement; each URL visited once. SSRF-guarded. Returns per-page titles and text snippets.",
  permission: "network",
  timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) seed URL." },
      maxPages: {
        type: "number",
        description: `Maximum total pages to fetch (default ${DEFAULT_MAX_PAGES}, hard cap ${HARD_MAX_PAGES}).`,
      },
      maxDepth: {
        type: "number",
        description: `Maximum link hops from the seed (default ${DEFAULT_MAX_DEPTH}; 0 = seed only).`,
      },
      sameOrigin: {
        type: "boolean",
        description: "Only follow links on the seed's origin (default true).",
      },
      maxBytes: { type: "number", description: `Per-page response byte cap (default ${DEFAULT_MAX_BYTES}).` },
      timeoutMs: { type: "number", description: `Per-page wall-clock timeout in ms (default ${DEFAULT_FETCH_TIMEOUT_MS}).` },
      allowPrivateHosts: {
        type: "boolean",
        description: "Permit loopback/private/link-local targets (default false).",
      },
      userAgent: { type: "string", description: "Override the User-Agent header." },
    },
    required: ["url"],
    additionalProperties: false,
  },
  run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    return runWebCrawl(input, ctx);
  },
};
