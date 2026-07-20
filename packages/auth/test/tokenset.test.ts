import { describe, it, expect } from "vitest";
import { tokenSetFromBody, isExpired, needsRefresh, DEFAULT_SKEW_MS } from "@nexuscode/auth";

describe("TokenSet lifecycle", () => {
  it("builds a TokenSet with an absolute expiry from expires_in", () => {
    const now = 1_000_000;
    const ts = tokenSetFromBody(
      { access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "Bearer", scope: "x" },
      now,
      "fallback",
    );
    expect(ts.accessToken).toBe("a");
    expect(ts.refreshToken).toBe("r");
    expect(ts.expiresAt).toBe(now + 3600 * 1000);
    expect(ts.scope).toBe("x");
    expect(ts.tokenType).toBe("Bearer");
  });

  it("falls back to requested scope and Bearer when the body omits them", () => {
    const ts = tokenSetFromBody({ access_token: "a", expires_in: 60 }, 0, "openid profile");
    expect(ts.scope).toBe("openid profile");
    expect(ts.tokenType).toBe("Bearer");
    expect(ts.refreshToken).toBeUndefined();
  });

  it("coerces a string expires_in", () => {
    const ts = tokenSetFromBody({ access_token: "a", expires_in: "120" }, 0, "s");
    expect(ts.expiresAt).toBe(120 * 1000);
  });

  it("isExpired is true only at/after the hard expiry", () => {
    const ts = tokenSetFromBody({ access_token: "a", expires_in: 100 }, 0, "s");
    expect(isExpired(ts, 99_000)).toBe(false);
    expect(isExpired(ts, 100_000)).toBe(true);
    expect(isExpired(ts, 200_000)).toBe(true);
  });

  it("needsRefresh triggers within the skew window before expiry", () => {
    const ts = tokenSetFromBody({ access_token: "a", expires_in: 100 }, 0, "s");
    const expiresAt = 100_000;
    expect(needsRefresh(ts, expiresAt - DEFAULT_SKEW_MS - 1)).toBe(false);
    expect(needsRefresh(ts, expiresAt - DEFAULT_SKEW_MS)).toBe(true);
    expect(needsRefresh(ts, expiresAt)).toBe(true);
  });
});
