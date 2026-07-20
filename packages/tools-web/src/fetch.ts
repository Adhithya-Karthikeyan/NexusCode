/**
 * `web_fetch` — dereference a single URL and return its readable content.
 *
 * Native `fetch` under an SSRF guard (loopback/private/link-local blocked by
 * default), with a wall-clock timeout, a streamed response byte cap, and
 * HTML→text extraction. Permission class `network`. Returns a `ToolResult`
 * (`isError: true`) rather than throwing on any failure — a blocked URL, a
 * network error, or malformed input — so the tool loop never crashes.
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

interface WebFetchInput {
  url: string;
  maxBytes?: number;
  timeoutMs?: number;
  raw?: boolean;
  allowPrivateHosts?: boolean;
  userAgent?: string;
}

function parseInput(input: unknown): WebFetchInput {
  const o = asObject(input);
  const out: WebFetchInput = { url: reqString(o, "url") };
  const maxBytes = optNumber(o, "maxBytes");
  const timeoutMs = optNumber(o, "timeoutMs");
  const raw = optBool(o, "raw");
  const allowPrivateHosts = optBool(o, "allowPrivateHosts");
  const userAgent = optString(o, "userAgent");
  if (maxBytes !== undefined) out.maxBytes = maxBytes;
  if (timeoutMs !== undefined) out.timeoutMs = timeoutMs;
  if (raw !== undefined) out.raw = raw;
  if (allowPrivateHosts !== undefined) out.allowPrivateHosts = allowPrivateHosts;
  if (userAgent !== undefined) out.userAgent = userAgent;
  return out;
}

function toFetchOptions(i: WebFetchInput): FetchOptions {
  const opts: FetchOptions = {};
  if (i.maxBytes !== undefined) opts.maxBytes = i.maxBytes;
  if (i.timeoutMs !== undefined) opts.timeoutMs = i.timeoutMs;
  if (i.raw !== undefined) opts.raw = i.raw;
  if (i.allowPrivateHosts !== undefined) opts.allowPrivate = i.allowPrivateHosts;
  if (i.userAgent !== undefined) opts.userAgent = i.userAgent;
  return opts;
}

async function runWebFetch(input: unknown, ctx: ToolContext): Promise<ToolResult> {
  const parsed = parseInput(input);
  try {
    const page = await fetchPage(parsed.url, toFetchOptions(parsed), ctx.signal);
    const header = [
      `URL: ${page.finalUrl}`,
      `Status: ${page.status}`,
      `Content-Type: ${page.contentType || "unknown"}`,
      page.title ? `Title: ${page.title}` : undefined,
      `Bytes: ${page.bytes}${page.truncated ? " (truncated at cap)" : ""}`,
      page.links.length > 0 ? `Links: ${page.links.length}` : undefined,
    ]
      .filter((x): x is string => x !== undefined)
      .join("\n");
    const body = page.text.length > 0 ? `\n\n${page.text}` : "";
    const content: ContentBlock[] = [{ type: "text", text: `${header}${body}` }];
    // An HTTP error status is surfaced to the model but is not a tool crash.
    if (!page.ok) return { ok: false, content, isError: true };
    return { ok: true, content };
  } catch (err) {
    const reason =
      err instanceof BlockedUrlError
        ? `web_fetch blocked: ${err.message}`
        : ctx.signal.aborted
          ? "web_fetch cancelled"
          : `web_fetch failed: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, content: [{ type: "text", text: reason }], isError: true };
  }
}

export const webFetchTool: Tool = {
  name: "web_fetch",
  description:
    "Fetch a single http(s) URL and return its readable text (HTML is extracted to prose). SSRF-guarded (loopback/private hosts blocked unless allowPrivateHosts), with a timeout and a response byte cap.",
  permission: "network",
  timeoutMs: DEFAULT_FETCH_TIMEOUT_MS,
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Absolute http(s) URL to fetch." },
      maxBytes: {
        type: "number",
        description: `Response body byte cap; the transfer is aborted past it (default ${DEFAULT_MAX_BYTES}).`,
      },
      timeoutMs: {
        type: "number",
        description: `Wall-clock timeout in ms (default ${DEFAULT_FETCH_TIMEOUT_MS}).`,
      },
      raw: {
        type: "boolean",
        description: "Return the raw response body instead of extracted text (default false).",
      },
      allowPrivateHosts: {
        type: "boolean",
        description:
          "Permit loopback/private/link-local targets (default false; SSRF guard blocks them otherwise).",
      },
      userAgent: { type: "string", description: "Override the User-Agent header." },
    },
    required: ["url"],
    additionalProperties: false,
  },
  run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    return runWebFetch(input, ctx);
  },
};
