import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  generateCodeVerifier,
  computeCodeChallenge,
  createPkcePair,
  generateState,
  base64url,
} from "@nexuscode/auth";

function expectedS256(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

describe("PKCE helpers", () => {
  it("generates a verifier in the RFC 7636 length range and URL-safe charset", () => {
    for (let i = 0; i < 50; i++) {
      const v = generateCodeVerifier();
      expect(v.length).toBeGreaterThanOrEqual(43);
      expect(v.length).toBeLessThanOrEqual(128);
      expect(v).toMatch(/^[A-Za-z0-9\-_]+$/);
    }
  });

  it("computes the S256 challenge exactly as base64url(SHA-256(verifier))", () => {
    const v = generateCodeVerifier();
    expect(computeCodeChallenge(v)).toBe(expectedS256(v));
  });

  it("createPkcePair yields a matching verifier/challenge pair with S256 method", () => {
    const pair = createPkcePair();
    expect(pair.method).toBe("S256");
    expect(pair.challenge).toBe(expectedS256(pair.verifier));
  });

  it("state values are random and unique", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(generateState());
    expect(seen.size).toBe(100);
  });

  it("base64url has no padding or unsafe chars", () => {
    const s = base64url(Buffer.from([0xff, 0xff, 0xff, 0xfe]));
    expect(s).not.toContain("=");
    expect(s).not.toContain("+");
    expect(s).not.toContain("/");
  });
});
