import { describe, it, expect } from "vitest";
import { redactArgs, redactSecrets, REDACTED } from "@nexuscode/tools";

describe("redactSecrets (value patterns)", () => {
  it("masks provider key shapes and bearer tokens", () => {
    expect(redactSecrets("key sk-abcdef0123456789ABCDEF")).toBe(`key ${REDACTED}`);
    expect(redactSecrets("Authorization: Bearer abcDEF123456_789+/xyz")).toContain(REDACTED);
    expect(redactSecrets("token ghp_ABCDEFGHIJKLMNOPQRSTUVWX0123456789")).toBe(`token ${REDACTED}`);
    expect(redactSecrets("aws AKIAIOSFODNN7EXAMPLE done")).toBe(`aws ${REDACTED} done`);
  });

  it("masks PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`before ${pem} after`)).toBe(`before ${REDACTED} after`);
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("just a normal sentence")).toBe("just a normal sentence");
  });

  it("masks assignment-style credentials in free text (env/code/JSON/YAML)", () => {
    expect(redactSecrets("DB_PASSWORD=supersecret123")).toBe(`DB_PASSWORD=${REDACTED}`);
    expect(redactSecrets('const password = "hunter2"')).toBe(`const password = "${REDACTED}"`);
    expect(redactSecrets('"api_key": "abc123DEF"')).toBe(`"api_key": "${REDACTED}"`);
    expect(redactSecrets("client_secret: myClientSecretValue")).toBe(`client_secret: ${REDACTED}`);
    expect(redactSecrets("AUTH_TOKEN=tok_9f8e7d6c")).toBe(`AUTH_TOKEN=${REDACTED}`);
  });

  it("masks Stripe underscore keys, npm and github fine-grained tokens", () => {
    expect(redactSecrets("stripe sk_live_abcdef0123456789")).toBe(`stripe ${REDACTED}`);
    expect(redactSecrets("pub pk_live_0123456789abcdef")).toBe(`pub ${REDACTED}`);
    expect(redactSecrets("npm_0123456789abcdefghijklmnopqrstuvwxyz done")).toBe(
      `${REDACTED} done`,
    );
    expect(redactSecrets("github_pat_11ABCDE0123456789_abcdefghijklmnop")).toBe(REDACTED);
  });

  it("masks raw JWTs without a Bearer prefix", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N";
    expect(redactSecrets(`token=${jwt}`)).not.toContain("eyJhbGci");
    expect(redactSecrets(`raw ${jwt} end`)).toBe(`raw ${REDACTED} end`);
  });

  it("masks passwords embedded in connection URLs", () => {
    expect(redactSecrets("postgres://user:s3cretpw@db.host:5432/app")).toBe(
      `postgres://user:${REDACTED}@db.host:5432/app`,
    );
    expect(redactSecrets("redis://:onlypw@cache:6379")).toBe(`redis://:${REDACTED}@cache:6379`);
  });

  it("does not mangle ordinary URLs without credentials", () => {
    expect(redactSecrets("see https://example.com/path?x=1")).toBe(
      "see https://example.com/path?x=1",
    );
  });
});

describe("redactArgs (deep)", () => {
  it("masks secret-named fields entirely", () => {
    const out = redactArgs({ password: "hunter2", token: "abc", nested: { apiKey: "x" }, ok: "keep" });
    expect(out).toEqual({ password: REDACTED, token: REDACTED, nested: { apiKey: REDACTED }, ok: "keep" });
  });

  it("scrubs secret-shaped values inside non-secret fields", () => {
    const out = redactArgs({ cmd: "echo sk-abcdef0123456789ABCDEF" }) as Record<string, string>;
    expect(out["cmd"]).toBe(`echo ${REDACTED}`);
  });

  it("recurses into arrays and preserves scalars", () => {
    const out = redactArgs({ list: ["a", { secret: "s" }], n: 5, b: true }) as Record<string, unknown>;
    expect(out["list"]).toEqual(["a", { secret: REDACTED }]);
    expect(out["n"]).toBe(5);
    expect(out["b"]).toBe(true);
  });
});
