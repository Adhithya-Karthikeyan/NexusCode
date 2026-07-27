import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretStore, redactSecret, redactInText, KeychainBackend } from "@nexuscode/config";

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

describe("KeychainBackend — bounded native calls (regression: a real keychain-auth prompt must never hang the CLI)", () => {
  // A fake `KeyringEntry` whose native call never resolves — stands in for the
  // real failure mode: an EXISTING keychain item (see `resolveAuthSecrets`,
  // called unconditionally by `buildAuthedRuntime` for every provider in the
  // default catalog, regardless of `-p`) that requires a fresh authorization
  // decision. Headless, nobody can click "Allow", so the native call just
  // never settles — exactly what this fakes without touching the real OS
  // keychain (which would be flaky/slow/environment-dependent in CI).
  function neverResolvingCtor(): new (service: string, username: string) => {
    getPassword(): Promise<string | undefined>;
    setPassword(password: string): Promise<void>;
    deletePassword(): Promise<boolean>;
  } {
    return class {
      getPassword(): Promise<string | undefined> {
        return new Promise(() => {});
      }
      setPassword(): Promise<void> {
        return new Promise(() => {});
      }
      deletePassword(): Promise<boolean> {
        return new Promise(() => {});
      }
    };
  }

  it("get() returns null instead of hanging when the native call never resolves", async () => {
    const backend = new KeychainBackend("test-svc", {
      timeoutMs: 30,
      loadCtor: async () => neverResolvingCtor(),
    });
    const started = Date.now();
    const result = await backend.get("anthropic");
    expect(result).toBeNull();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("set() returns false instead of hanging, so the caller falls through to the file backend", async () => {
    const backend = new KeychainBackend("test-svc", {
      timeoutMs: 30,
      loadCtor: async () => neverResolvingCtor(),
    });
    const started = Date.now();
    const ok = await backend.set("anthropic", "sk-ant-whatever");
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("delete() returns false instead of hanging", async () => {
    const backend = new KeychainBackend("test-svc", {
      timeoutMs: 30,
      loadCtor: async () => neverResolvingCtor(),
    });
    const started = Date.now();
    const ok = await backend.delete("anthropic");
    expect(ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("end-to-end: createSecretStore's chain falls through to the file backend when the keychain hangs", async () => {
    // Exercises the REAL path `hasCredential()`/`resolveAuthSecrets()` drive —
    // `ChainedSecretStore.get()` awaiting a stuck keychain — proving the whole
    // chain degrades instead of propagating the hang to the caller. This is
    // the regression for the actual reported hang: `buildAuthedRuntime` calls
    // `hasCredential(..., "anthropic", secrets)` unconditionally on every run
    // regardless of `-p`, which lands here.
    const file = vaultPath();
    const store = createSecretStore({
      env: {},
      filePath: file,
      passphrase: "pw",
      keychainTimeoutMs: 30,
      keychainLoadCtor: async () => neverResolvingCtor(),
    });
    const started = Date.now();
    const result = await store.get("anthropic");
    expect(result).toBeNull(); // falls through the stuck keychain to the empty file vault
    expect(Date.now() - started).toBeLessThan(1_000);
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
