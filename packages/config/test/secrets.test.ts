import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore, redactSecret, redactInText } from "@nexuscode/config";

function vaultPath(): string {
  return join(mkdtempSync(join(tmpdir(), "nx-sec-")), "secrets.enc.json");
}

const SECRET = "sk-ant-abcdefghijklmnop1234";

describe("SecretStore — resolution chain", () => {
  it("resolves env first and reports source 'env'", async () => {
    const store = createSecretStore({
      env: { FOO_API_KEY: "env-value" },
      disableKeychain: true,
      filePath: vaultPath(),
      passphrase: "pw",
    });
    expect(await store.get("foo")).toBe("env-value");
    expect(await store.source("foo")).toBe("env");
  });

  it("falls back to the encrypted file and reports source 'file'", async () => {
    const file = vaultPath();
    const store = createSecretStore({ env: {}, disableKeychain: true, filePath: file, passphrase: "pw" });
    await store.set("bar", SECRET);
    expect(await store.get("bar")).toBe(SECRET);
    expect(await store.source("bar")).toBe("file");
  });

  it("env takes precedence over a value already in the file", async () => {
    const file = vaultPath();
    const writer = createSecretStore({ env: {}, disableKeychain: true, filePath: file, passphrase: "pw" });
    await writer.set("baz", "file-value");

    const reader = createSecretStore({
      env: { BAZ_API_KEY: "env-value" },
      disableKeychain: true,
      filePath: file,
      passphrase: "pw",
    });
    expect(await reader.get("baz")).toBe("env-value");
    expect(await reader.source("baz")).toBe("env");
  });

  it("never writes the plaintext secret to disk", async () => {
    const file = vaultPath();
    const store = createSecretStore({ env: {}, disableKeychain: true, filePath: file, passphrase: "pw" });
    await store.set("bar", SECRET);
    expect(existsSync(file)).toBe(true);
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(SECRET);
  });

  it("rejects decryption with the wrong passphrase", async () => {
    const file = vaultPath();
    const good = createSecretStore({ env: {}, disableKeychain: true, filePath: file, passphrase: "right" });
    await good.set("bar", SECRET);

    const bad = createSecretStore({ env: {}, disableKeychain: true, filePath: file, passphrase: "wrong" });
    await expect(bad.get("bar")).rejects.toThrow();
  });

  it("returns null and source null for an unknown ref", async () => {
    const store = createSecretStore({ env: {}, disableKeychain: true, filePath: vaultPath(), passphrase: "pw" });
    expect(await store.get("missing")).toBeNull();
    expect(await store.source("missing")).toBeNull();
  });

  it("delete removes a stored secret", async () => {
    const file = vaultPath();
    const store = createSecretStore({ env: {}, disableKeychain: true, filePath: file, passphrase: "pw" });
    await store.set("bar", SECRET);
    await store.delete("bar");
    expect(await store.get("bar")).toBeNull();
    expect(await store.source("bar")).toBeNull();
  });
});

describe("redaction", () => {
  it("masks a key to <prefix>…<last4>", () => {
    expect(redactSecret(SECRET)).toBe("sk-ant-…1234");
    expect(redactSecret("xai-verylongtokenABCD")).toBe("xai-…ABCD");
  });

  it("collapses very short values entirely", () => {
    expect(redactSecret("short")).toBe("…");
    expect(redactSecret("")).toBe("");
  });

  it("redactInText replaces every occurrence and leaks no suffix", () => {
    const text = `Authorization: Bearer ${SECRET}; retry with ${SECRET}`;
    const out = redactInText(text, [SECRET]);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("abcdefghijklmnop1234");
    expect(out).toContain("sk-ant-…1234");
  });
});
