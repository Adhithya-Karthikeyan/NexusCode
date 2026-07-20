import { describe, it, expect } from "vitest";
import {
  assertAllowedUrl,
  BlockedUrlError,
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateHostname,
} from "../src/index.js";

describe("SSRF guard — assertAllowedUrl", () => {
  it("blocks loopback 127.0.0.1 by default", async () => {
    await expect(assertAllowedUrl("http://127.0.0.1:8080/x")).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("blocks the cloud metadata address 169.254.169.254", async () => {
    await expect(assertAllowedUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });

  it("blocks private ranges 10.x / 192.168.x / 172.16-31.x", async () => {
    for (const host of ["10.0.0.5", "192.168.1.1", "172.16.9.9", "172.31.255.1"]) {
      await expect(assertAllowedUrl(`http://${host}/`)).rejects.toBeInstanceOf(BlockedUrlError);
    }
  });

  it("does NOT block a public range 172.32.x (just outside the private block)", async () => {
    // 172.32.0.0 is public; guard must not over-block. IP literal ⇒ no DNS.
    const url = await assertAllowedUrl("http://172.32.0.1/");
    expect(url.hostname).toBe("172.32.0.1");
  });

  it("blocks localhost and *.local hostnames", async () => {
    await expect(assertAllowedUrl("http://localhost:3000/")).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertAllowedUrl("http://foo.localhost/")).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertAllowedUrl("http://printer.local/")).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("blocks IPv6 loopback ::1 and unique-local fc00::/7", async () => {
    await expect(assertAllowedUrl("http://[::1]/")).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertAllowedUrl("http://[fd00::1]/")).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("blocks IPv4-mapped IPv6 loopback ::ffff:127.0.0.1", async () => {
    await expect(assertAllowedUrl("http://[::ffff:127.0.0.1]/")).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("blocks non-http(s) schemes", async () => {
    await expect(assertAllowedUrl("file:///etc/passwd")).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertAllowedUrl("ftp://example.com/x")).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(assertAllowedUrl("gopher://example.com/")).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("rejects a syntactically invalid URL", async () => {
    await expect(assertAllowedUrl("not a url")).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("allows a public IP literal without DNS resolution", async () => {
    const url = await assertAllowedUrl("http://8.8.8.8/");
    expect(url.hostname).toBe("8.8.8.8");
  });

  it("allowPrivate bypasses the guard for a local target", async () => {
    const url = await assertAllowedUrl("http://127.0.0.1:9999/x", { allowPrivate: true });
    expect(url.port).toBe("9999");
  });
});

describe("SSRF guard — IP classifiers", () => {
  it("classifies IPv4 private ranges", () => {
    expect(isPrivateIPv4([127, 0, 0, 1])).toBe(true);
    expect(isPrivateIPv4([10, 1, 2, 3])).toBe(true);
    expect(isPrivateIPv4([169, 254, 0, 1])).toBe(true);
    expect(isPrivateIPv4([172, 16, 0, 1])).toBe(true);
    expect(isPrivateIPv4([172, 32, 0, 1])).toBe(false);
    expect(isPrivateIPv4([8, 8, 8, 8])).toBe(false);
    expect(isPrivateIPv4([100, 64, 0, 1])).toBe(true);
    expect(isPrivateIPv4([224, 0, 0, 1])).toBe(true);
  });

  it("classifies IPv6 private addresses", () => {
    expect(isPrivateIPv6("::1")).toBe(true);
    expect(isPrivateIPv6("fe80::1")).toBe(true);
    expect(isPrivateIPv6("fd12::34")).toBe(true);
    expect(isPrivateIPv6("2001:4860:4860::8888")).toBe(false);
  });

  it("classifies local hostnames", () => {
    expect(isPrivateHostname("localhost")).toBe(true);
    expect(isPrivateHostname("a.localhost")).toBe(true);
    expect(isPrivateHostname("nas.local")).toBe(true);
    expect(isPrivateHostname("example.com")).toBe(false);
  });
});
