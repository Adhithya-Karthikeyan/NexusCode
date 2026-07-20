/**
 * The shared fetch-and-extract core used by both `web_fetch` and `web_crawl`.
 *
 * Invariants (system-spec §6, uniform tool pattern):
 *   - SSRF-guarded: every URL passes `assertAllowedUrl` before a socket opens.
 *   - Bounded: a hard wall-clock timeout (its own AbortController, linked to the
 *     caller's `ctx.signal`) and a response-body BYTE CAP enforced while
 *     streaming — we stop reading and abort the transfer the moment the cap is
 *     exceeded, so a hostile server cannot exhaust memory.
 *   - No secrets on the wire: only an explicit, non-secret User-Agent and the
 *     caller's declared headers are sent; process env is never forwarded.
 *   - Optional-lazy readability: if a readability extractor is installed we use
 *     it, otherwise the always-available `extractText` fallback runs. Absence of
 *     the optional library NEVER errors — it just uses the built-in extractor.
 */

import { assertAllowedUrl, BlockedUrlError, type SsrfOptions } from "./ssrf.js";
import { extractLinks, extractText, type ExtractedDocument } from "./html.js";

export const DEFAULT_FETCH_TIMEOUT_MS = 20_000;

/**
 * Redirect hops we follow before giving up. We follow redirects OURSELVES
 * (`redirect: "manual"`) rather than delegating to the fetch/undici layer,
 * because undici re-runs NO SSRF policy on the intermediate `Location`s — a
 * permitted public URL could 30x-bounce to `http://169.254.169.254/` (cloud
 * metadata / IMDS) or an internal `10.x` service and its body would be returned
 * to the model. By looping here we re-apply `assertAllowedUrl` on EVERY hop.
 */
export const MAX_REDIRECTS = 5;

/** Response-body byte cap when the caller doesn't set `maxBytes` (5 MiB). */
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** A stable, honest User-Agent. Never carries anything secret. */
export const DEFAULT_USER_AGENT = "NexusCode/1.0 (+https://nexuscode.dev; web_fetch)";

export interface FetchOptions extends SsrfOptions {
  maxBytes?: number;
  timeoutMs?: number;
  userAgent?: string;
  /** Return the raw response body instead of extracted text. */
  raw?: boolean;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  ok: boolean;
  contentType: string;
  bytes: number;
  truncated: boolean;
  title: string | undefined;
  /** Extracted text (or raw body when `raw`), already byte-capped. */
  text: string;
  /** Resolved, deduped, http(s) hyperlink targets found in the page. */
  links: string[];
}

/** True for content types we extract as HTML; everything else is treated as text/binary. */
function isHtml(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return ct.includes("text/html") || ct.includes("application/xhtml");
}

function isTextual(contentType: string): boolean {
  const ct = contentType.toLowerCase();
  return (
    ct.startsWith("text/") ||
    ct.includes("json") ||
    ct.includes("xml") ||
    ct.includes("javascript") ||
    ct.includes("csv") ||
    ct === ""
  );
}

/**
 * Try to load an optional readability extractor. Feature-detected at call time;
 * if the package isn't installed we return undefined and the caller falls back
 * to the built-in `extractText`. Never throws.
 */
async function loadReadability(): Promise<
  ((html: string) => ExtractedDocument) | undefined
> {
  try {
    // Optional lazy dependencies: NOT hard deps of this package. Both must be
    // present (readability needs a DOM); either missing ⇒ built-in extractor.
    // The specifiers are indirected through variables so the compiler does not
    // try to statically resolve (and fail on) these uninstalled modules.
    const readabilitySpec = "@mozilla/readability";
    const jsdomSpec = "jsdom";
    const readabilityMod = (await import(readabilitySpec).catch(() => undefined)) as
      | { Readability?: new (doc: unknown) => { parse(): unknown } }
      | undefined;
    const jsdomMod = (await import(jsdomSpec).catch(() => undefined)) as
      | { JSDOM?: new (html: string) => { window: { document: unknown } } }
      | undefined;
    const Readability = readabilityMod?.Readability;
    const JSDOM = jsdomMod?.JSDOM;
    if (typeof Readability !== "function" || typeof JSDOM !== "function") return undefined;
    return (html: string): ExtractedDocument => {
      const dom = new JSDOM(html);
      const article = new Readability(dom.window.document).parse() as
        | { title?: string; textContent?: string }
        | null;
      if (!article) return extractText(html);
      return {
        title: article.title,
        text: (article.textContent ?? "").replace(/\n{3,}/g, "\n\n").trim(),
      };
    };
  } catch {
    return undefined;
  }
}

/** Byte-decode a buffer as UTF-8 (lossy — invalid sequences become U+FFFD). */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Fetch a single URL and extract its readable content, enforcing the SSRF
 * policy, the wall-clock timeout, and the response byte cap. Rejects (throws)
 * only on a blocked URL (`BlockedUrlError`), an aborted/failed transfer, or an
 * argument error — callers convert those into a `ToolResult`.
 */
export async function fetchPage(rawUrl: string, opts: FetchOptions, signal: AbortSignal): Promise<FetchedPage> {
  const ssrf: SsrfOptions = {};
  if (opts.allowPrivate !== undefined) ssrf.allowPrivate = opts.allowPrivate;
  if (opts.resolveDns !== undefined) ssrf.resolveDns = opts.resolveDns;
  const url = await assertAllowedUrl(rawUrl, ssrf);

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  const ac = new AbortController();
  const onParentAbort = (): void => ac.abort();
  signal.addEventListener("abort", onParentAbort, { once: true });
  if (signal.aborted) ac.abort();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  // Stream the body, enforcing the byte cap as we go. A single try/finally
  // guarantees the timeout timer and abort listener are always torn down —
  // whether fetch rejects, the transfer aborts, or the body drains cleanly.
  let response: Response;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  let contentType = "";
  try {
    // Follow redirects MANUALLY, re-running the SSRF guard on every hop (see
    // MAX_REDIRECTS). `redirect: "manual"` returns the raw 3xx response with a
    // readable `Location`; we resolve it against the current URL, re-assert the
    // policy, and loop — so a redirect to a blocked target is rejected instead
    // of silently dereferenced by undici.
    let current: URL = url;
    for (let hop = 0; ; hop++) {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: ac.signal,
        headers: { "user-agent": userAgent, accept: "text/html,application/xhtml+xml,text/*;q=0.9,*/*;q=0.5" },
      });
      const isRedirect = response.status >= 300 && response.status < 400;
      const location = isRedirect ? response.headers.get("location") : null;
      if (!location) break; // a final (non-redirect, or location-less) response
      if (hop >= MAX_REDIRECTS) {
        throw new BlockedUrlError(`too many redirects (> ${MAX_REDIRECTS}) starting from ${url.toString()}`);
      }
      // Discard the redirect body so the socket is freed before the next hop.
      await response.body?.cancel().catch(() => undefined);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new BlockedUrlError(`redirect to malformed location: ${location}`);
      }
      // Re-apply the FULL SSRF policy (scheme + private-IP + DNS) to every hop.
      current = await assertAllowedUrl(next.toString(), ssrf);
    }
    contentType = response.headers.get("content-type") ?? "";
    const body = response.body;
    if (body) {
      const reader = body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        const remaining = maxBytes - total;
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, Math.max(0, remaining)));
          total += Math.max(0, remaining);
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onParentAbort);
  }

  const buf = concat(chunks, total);
  const bodyText = isTextual(contentType) || isHtml(contentType) ? decodeUtf8(buf) : "";

  let title: string | undefined;
  let text: string;
  let links: string[] = [];

  if (opts.raw) {
    text = bodyText;
    if (isHtml(contentType)) {
      title = extractText(bodyText).title;
      links = extractLinks(bodyText, response.url || url.toString());
    }
  } else if (isHtml(contentType)) {
    const readability = await loadReadability();
    const doc = readability ? readability(bodyText) : extractText(bodyText);
    title = doc.title;
    text = doc.text;
    links = extractLinks(bodyText, response.url || url.toString());
  } else if (isTextual(contentType)) {
    text = bodyText;
  } else {
    text = `[non-text content: ${contentType || "unknown"}, ${total} bytes]`;
  }

  return {
    url: url.toString(),
    finalUrl: response.url || url.toString(),
    status: response.status,
    ok: response.ok,
    contentType,
    bytes: total,
    truncated,
    title,
    text,
    links,
  };
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    if (offset + c.byteLength > total) {
      out.set(c.subarray(0, total - offset), offset);
      break;
    }
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
