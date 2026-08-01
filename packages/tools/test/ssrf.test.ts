import { describe, it, expect, vi, beforeEach } from "vitest";
import { assertAllowedUrl, BlockedUrlError } from "@nexuscode/tools";

// The DNS-rebinding branch (src/ssrf.ts ~L211-230): a non-IP-literal, non-local
// hostname is resolved via `dns.lookup` and the RESOLVED addresses — not the
// hostname text — are what gets classified. `node:dns` is mocked so these
// cases are deterministic and offline (no real network/DNS involved).
vi.mock("node:dns", () => ({
  promises: { lookup: vi.fn() },
}));

import { promises as dns } from "node:dns";
// `dns.promises.lookup` is overloaded (single-address vs. `{ all: true }`
// array-returning forms); ssrf.ts only ever calls the array form, so the mock
// is narrowed to that one signature rather than fighting the overload set.
type LookupAllFn = (
  hostname: string,
  options: { all: true },
) => Promise<Array<{ address: string; family: number }>>;
const lookupMock = vi.mocked(dns.lookup as unknown as LookupAllFn);

beforeEach(() => {
  lookupMock.mockReset();
});

describe("SSRF guard — DNS rebinding (assertAllowedUrl)", () => {
  it("blocks a public-looking hostname that resolves to a private IPv4 address (10.0.0.5)", async () => {
    lookupMock.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    await expect(assertAllowedUrl("http://public.example.com/x")).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertAllowedUrl("http://public.example.com/x")).rejects.toThrow(
      /resolves to private address 10\.0\.0\.5/,
    );
    expect(lookupMock).toHaveBeenCalledWith("public.example.com", { all: true });
  });

  it("blocks a hostname that resolves to a v4-mapped IPv6 loopback (::ffff:7f00:1)", async () => {
    lookupMock.mockResolvedValue([{ address: "::ffff:7f00:1", family: 6 }]);
    await expect(assertAllowedUrl("http://public.example.com/x")).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertAllowedUrl("http://public.example.com/x")).rejects.toThrow(
      /resolves to private address ::ffff:7f00:1/,
    );
  });

  it("PINS the deliberate fail-open policy: a DNS lookup failure allows the URL through", async () => {
    // src/ssrf.ts comment: "Resolution failure is not a policy decision; let
    // the actual fetch surface a clear network error rather than masking it
    // here." This is intentional current behavior, not a gap this test is
    // meant to close — it documents/pins it so a future change is deliberate.
    lookupMock.mockRejectedValue(new Error("ENOTFOUND public.example.com"));
    const url = await assertAllowedUrl("http://public.example.com/x");
    expect(url.hostname).toBe("public.example.com");
  });

  it("resolveDns:false skips DNS resolution entirely (lookup never called)", async () => {
    const url = await assertAllowedUrl("http://public.example.com/x", { resolveDns: false });
    expect(url.hostname).toBe("public.example.com");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("a hostname resolving to only public addresses is allowed", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const url = await assertAllowedUrl("http://public.example.com/x");
    expect(url.hostname).toBe("public.example.com");
  });
});

describe("SSRF guard — allowlist semantics (assertAllowedUrl)", () => {
  it("permits an allowlisted private IP literal without consulting DNS", async () => {
    const url = await assertAllowedUrl("http://10.0.0.5/", { allowlist: ["10.0.0.5"] });
    expect(url.hostname).toBe("10.0.0.5");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("matches the allowlist case-insensitively", async () => {
    const url = await assertAllowedUrl("http://Internal.Example.COM/", { allowlist: ["internal.example.com"] });
    expect(url.hostname).toBe("internal.example.com");
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("ignores a trailing dot on both the host and the allowlist entry", async () => {
    const url = await assertAllowedUrl("http://internal.example.com./", { allowlist: ["internal.example.com"] });
    expect(url.hostname).toBe("internal.example.com.");
  });

  it("does not allowlist-match a different hostname (e.g. a redirect target on another host)", async () => {
    lookupMock.mockResolvedValue([{ address: "203.0.113.5", family: 4 }]);
    await expect(
      assertAllowedUrl("http://127.0.0.1/", { allowlist: ["internal.example.com"] }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("an empty allowlist bypasses nothing", async () => {
    await expect(assertAllowedUrl("http://10.0.0.5/", { allowlist: [] })).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
