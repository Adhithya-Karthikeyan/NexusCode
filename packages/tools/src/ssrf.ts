/**
 * SSRF guard shared by every tool group that dereferences a caller-supplied URL
 * (currently `@nexuscode/tools-web`'s `web_fetch`/`web_crawl` and
 * `@nexuscode/tools-browser`'s `browser_navigate`). Any such tool will happily
 * open whatever URL the model (or content it fetched/crawled/rendered) hands
 * it — which, unguarded, is a Server-Side Request Forgery primitive: the model
 * could point us at `http://127.0.0.1:…`, the cloud metadata endpoint
 * `169.254.169.254`, or an internal `10.x` service and read back the response.
 * So by default we BLOCK:
 *
 *   - non-http(s) schemes (`file:`, `ftp:`, `gopher:`, …),
 *   - loopback / private / link-local / CGNAT / reserved IP literals (v4 and v6,
 *     including `::ffff:`-mapped v4),
 *   - `localhost` and `*.local` / `*.localhost` names, and
 *   - any hostname that RESOLVES (DNS) to one of the above — the "DNS rebinding"
 *     hole where a public name maps to a private address.
 *
 * A caller may opt in to private targets per call (`allowPrivate`) — used by the
 * offline test suite to reach a local `127.0.0.1` http server, and by operators
 * who genuinely intend to fetch an internal host — or allowlist SPECIFIC
 * hostnames/IP-literals via `allowlist` (an exact, case-insensitive match) for
 * the "intentional internal use" case without disabling the guard entirely. The
 * guard never itself makes a network request other than the DNS lookup;
 * IP-literal targets skip DNS entirely, so the test suite stays fully offline
 * and deterministic.
 */

import { isIP } from "node:net";
import { promises as dns } from "node:dns";

/** Thrown when a URL is rejected by the SSRF policy. Callers convert to a ToolResult. */
export class BlockedUrlError extends Error {
  override readonly name = "BlockedUrlError";
  constructor(message: string) {
    super(message);
  }
}

export interface SsrfOptions {
  /** Permit loopback/private/link-local targets (default false). */
  allowPrivate?: boolean;
  /**
   * Resolve non-literal hostnames via DNS and re-check the resolved addresses
   * (default true). Disable only in environments where DNS itself is untrusted
   * or unavailable; IP-literal targets are always checked regardless.
   */
  resolveDns?: boolean;
  /**
   * Exact hostnames or IP literals permitted past the private/loopback block
   * regardless of `allowPrivate` — the operator-configured escape hatch for a
   * specific internal host a tool is intentionally allowed to reach (e.g. an
   * internal API gateway). Matched case-insensitively against the URL's
   * hostname (IPv6 brackets stripped, trailing dot ignored); does not affect
   * scheme validation. Empty/omitted ⇒ no allowlist bypass.
   */
  allowlist?: string[];
}

function parseIPv4(ip: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if (a > 255 || b > 255 || c > 255 || d > 255) return null;
  return [a, b, c, d];
}

/** True for any IPv4 address that must not be dereferenced from a tool. */
export function isPrivateIPv4(parts: [number, number, number, number]): boolean {
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24 IETF protocol
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/**
 * Expand an IPv6 literal (with `::` compression and optional trailing dotted
 * IPv4) into its 16 bytes. Returns null on anything unparseable. The URL parser
 * may hand us either `::ffff:127.0.0.1` or its compressed hex form
 * `::ffff:7f00:1`; both must classify identically, hence byte-level expansion.
 */
export function expandIPv6(input: string): number[] | null {
  let s = (input.split("%")[0] ?? "").toLowerCase();
  if (s.length === 0) return null;

  // Fold a trailing dotted-IPv4 suffix into two hex groups.
  const lastColon = s.lastIndexOf(":");
  const tail = lastColon >= 0 ? s.slice(lastColon + 1) : s;
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const g1 = ((v4[0] << 8) | v4[1]).toString(16);
    const g2 = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${g1}:${g2}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): string[] => (part.length === 0 ? [] : part.split(":"));
  const left = toGroups(halves[0] ?? "");
  const right = halves.length === 2 ? toGroups(halves[1] ?? "") : null;

  let groups: string[];
  if (right === null) {
    if (left.length !== 8) return null; // no "::" ⇒ must be a full address
    groups = left;
  } else {
    const fill = 8 - (left.length + right.length);
    if (fill < 0) return null;
    groups = [...left, ...Array<string>(fill).fill("0"), ...right];
  }

  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = Number.parseInt(g, 16);
    bytes.push((v >> 8) & 0xff, v & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/** True for any IPv6 address that must not be dereferenced from a tool. */
export function isPrivateIPv6(ip: string): boolean {
  const b = expandIPv6(ip);
  if (!b) {
    // Unparseable ⇒ fail closed on the obvious textual forms.
    const s = ip.toLowerCase();
    return s === "::1" || s === "::" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe8");
  }
  // ::/128 unspecified and ::1/128 loopback
  if (b.slice(0, 15).every((x) => x === 0) && (b[15] === 0 || b[15] === 1)) return true;
  // fc00::/7 unique-local
  if ((b[0]! & 0xfe) === 0xfc) return true;
  // fe80::/10 link-local
  if (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) return true;
  // ::ffff:0:0/96 IPv4-mapped ⇒ classify the embedded IPv4
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
    return isPrivateIPv4([b[12]!, b[13]!, b[14]!, b[15]!]);
  }
  return false;
}

/** True for host NAMES (not IP literals) that resolve to the local machine. */
export function isPrivateHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (h === "localhost") return true;
  if (h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true;
  return false;
}

function stripBrackets(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "");
}

/** True when `host` exactly matches (case/trailing-dot insensitive) an allowlist entry. */
function isAllowlisted(host: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) return false;
  const h = host.toLowerCase().replace(/\.$/, "");
  return allowlist.some((entry) => entry.toLowerCase().replace(/\.$/, "") === h);
}

/**
 * Parse `rawUrl` and enforce the SSRF policy. Returns the parsed `URL` when the
 * target is permitted; throws `BlockedUrlError` otherwise. `NexusError` for a
 * syntactically invalid URL (an argument error, not a policy block).
 */
export async function assertAllowedUrl(rawUrl: string, opts: SsrfOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedUrlError(`invalid URL: ${rawUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`blocked non-http(s) URL scheme: ${url.protocol}`);
  }

  if (opts.allowPrivate) return url;

  const host = stripBrackets(url.hostname);
  if (isAllowlisted(host, opts.allowlist)) return url;

  const kind = isIP(host);

  if (kind === 4) {
    const p = parseIPv4(host);
    if (p && isPrivateIPv4(p)) throw new BlockedUrlError(`blocked private/loopback address: ${host}`);
    return url;
  }
  if (kind === 6) {
    if (isPrivateIPv6(host)) throw new BlockedUrlError(`blocked private/loopback address: ${host}`);
    return url;
  }

  if (isPrivateHostname(host)) {
    throw new BlockedUrlError(`blocked local hostname: ${host}`);
  }

  if (opts.resolveDns !== false) {
    let addrs: Array<{ address: string; family: number }> = [];
    try {
      addrs = await dns.lookup(host, { all: true });
    } catch {
      // Resolution failure is not a policy decision; let the actual fetch
      // surface a clear network error rather than masking it here.
      return url;
    }
    for (const a of addrs) {
      if (a.family === 4) {
        const p = parseIPv4(a.address);
        if (p && isPrivateIPv4(p)) {
          throw new BlockedUrlError(`blocked: ${host} resolves to private address ${a.address}`);
        }
      } else if (isPrivateIPv6(a.address)) {
        throw new BlockedUrlError(`blocked: ${host} resolves to private address ${a.address}`);
      }
    }
  }

  return url;
}
