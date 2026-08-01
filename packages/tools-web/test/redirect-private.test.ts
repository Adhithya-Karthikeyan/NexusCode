import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetchPage, BlockedUrlError } from "../src/index.js";

/**
 * Regression coverage for audit finding tools-F4: the existing fetch.test.ts
 * suite exercises the redirect loop exclusively with `allowPrivate: true`,
 * which short-circuits assertAllowedUrl's per-hop address classification
 * entirely (src/ssrf.ts: `if (opts.allowPrivate) return url;`) — so it never
 * actually proves a redirect TO a private target gets blocked when the guard
 * is live. Here the guard stays live (no allowPrivate) and only server A's
 * host is allowlisted, so the redirect hop to server B (a different,
 * non-allowlisted, private host) must be independently re-evaluated and
 * rejected — proving `current = await assertAllowedUrl(next.toString(), ssrf)`
 * (src/http.ts:183) actually enforces the policy on every hop rather than
 * inheriting trust from the allowlisted starting host.
 *
 * Server A and server B are given DISTINCT loopback literals (IPv6 `::1` vs
 * IPv4 `127.0.0.1`) precisely so the allowlist — which matches the exact
 * hostname string, ignoring port (src/ssrf.ts `isAllowlisted`) — cannot
 * accidentally cover both servers just because they're both "localhost".
 */

let serverA: Server;
let serverB: Server;
let baseA = "";
let baseB = "";
let serverBHits = 0;

beforeAll(async () => {
  serverB = createServer((_req, res) => {
    serverBHits++;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("should never be reached");
  });
  await new Promise<void>((resolve) => serverB.listen(0, "127.0.0.1", resolve));
  const addrB = serverB.address() as AddressInfo;
  baseB = `http://127.0.0.1:${addrB.port}`;

  serverA = createServer((_req, res) => {
    // Redirects to a DIFFERENT host (server B, plain IPv4 loopback) that is
    // not in the allowlist.
    res.writeHead(302, { location: `${baseB}/` });
    res.end("redirecting");
  });
  await new Promise<void>((resolve) => serverA.listen(0, "::1", resolve));
  const addrA = serverA.address() as AddressInfo;
  baseA = `http://[::1]:${addrA.port}`;
});

afterAll(async () => {
  await Promise.all([
    new Promise<void>((resolve, reject) => serverA.close((e) => (e ? reject(e) : resolve()))),
    new Promise<void>((resolve, reject) => serverB.close((e) => (e ? reject(e) : resolve()))),
  ]);
});

describe("SSRF guard — redirect to an unlisted private host is blocked per-hop", () => {
  it("rejects the redirect and never lets server B receive a request", async () => {
    serverBHits = 0;
    await expect(
      fetchPage(`${baseA}/`, { allowlist: ["::1"] }, new AbortController().signal),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    expect(serverBHits).toBe(0);
  });

  it("the rejection reason names the blocked private address, not an allowlist bypass", async () => {
    serverBHits = 0;
    await expect(fetchPage(`${baseA}/`, { allowlist: ["::1"] }, new AbortController().signal)).rejects.toThrow(
      /blocked private\/loopback address: 127\.0\.0\.1/,
    );
    expect(serverBHits).toBe(0);
  });
});
