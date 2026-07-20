/**
 * The composite `SecretStore` resolution chain:
 *
 *   1. process.env[apiKeyEnv]   — CI / Docker / no-keychain
 *   2. OS keychain              — @napi-rs/keyring (optional native dep)
 *   3. Encrypted-file fallback  — node:crypto AES-256-GCM, mode 0600
 *
 * Never plaintext, never logged. `redactSecret` masks a value to
 * `<prefix>…<last4>` for any log/trace surface.
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { NexusError } from "@nexuscode/shared";
import type { SecretSource, SecretStore } from "./store.js";
import { nexusPaths } from "../paths.js";

// ── Redaction ───────────────────────────────────────────────────────────────

const KEY_PREFIXES = ["sk-ant-", "sk-", "xai-", "gsk_", "AIza", "ghp_", "key-"] as const;

/** Mask a secret to `<recognized-prefix>…<last4>`; safe to log. */
export function redactSecret(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "…";
  const last4 = value.slice(-4);
  let prefix = "";
  for (const p of KEY_PREFIXES) {
    if (value.startsWith(p)) {
      prefix = p;
      break;
    }
  }
  return `${prefix}…${last4}`;
}

/** Replace every occurrence of any known secret in `text` with its redaction. */
export function redactInText(text: string, secrets: Iterable<string>): string {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join(redactSecret(s));
  }
  return out;
}

// ── Backends ─────────────────────────────────────────────────────────────────

class EnvBackend {
  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly envVarFor: (ref: string) => string | undefined,
  ) {}

  get(ref: string): string | null {
    const name = this.envVarFor(ref);
    if (!name) return null;
    const v = this.env[name];
    return v && v.length > 0 ? v : null;
  }
}

/** Loosely-typed shape of `@napi-rs/keyring`'s `AsyncEntry`. */
interface KeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
  deletePassword(): Promise<boolean>;
}
type KeyringEntryCtor = new (service: string, username: string) => KeyringEntry;

class KeychainBackend {
  private ctor: KeyringEntryCtor | null | undefined;

  constructor(private readonly service: string) {}

  private async load(): Promise<KeyringEntryCtor | null> {
    if (this.ctor !== undefined) return this.ctor;
    try {
      const mod = (await import("@napi-rs/keyring")) as { AsyncEntry?: KeyringEntryCtor };
      this.ctor = typeof mod.AsyncEntry === "function" ? mod.AsyncEntry : null;
    } catch {
      this.ctor = null;
    }
    return this.ctor;
  }

  async available(): Promise<boolean> {
    return (await this.load()) !== null;
  }

  private async entry(ref: string): Promise<KeyringEntry | null> {
    const Ctor = await this.load();
    return Ctor ? new Ctor(this.service, ref) : null;
  }

  async get(ref: string): Promise<string | null> {
    const e = await this.entry(ref);
    if (!e) return null;
    try {
      const v = await e.getPassword();
      return v && v.length > 0 ? v : null;
    } catch {
      // NoEntry (or platform ambiguity) → treat as absent.
      return null;
    }
  }

  async set(ref: string, value: string): Promise<boolean> {
    const e = await this.entry(ref);
    if (!e) return false;
    try {
      await e.setPassword(value);
      return true;
    } catch {
      // Platform/keychain failure (e.g. no default keychain in a headless or
      // sandboxed environment) → fall through to the encrypted-file backend,
      // exactly like `get`/`delete` already do, instead of crashing the caller.
      return false;
    }
  }

  async delete(ref: string): Promise<boolean> {
    const e = await this.entry(ref);
    if (!e) return false;
    try {
      return await e.deletePassword();
    } catch {
      return false;
    }
  }
}

interface VaultRecord {
  v: 1;
  salt: string;
  iv: string;
  ct: string;
  tag: string;
}

class EncryptedFileBackend {
  constructor(
    private readonly filePath: string,
    private readonly getPassphrase: () => Promise<string | null>,
  ) {}

  private async readAll(): Promise<Record<string, VaultRecord>> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, VaultRecord>) : {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new NexusError("secret_backend", "failed to read secrets vault", { cause: e });
    }
  }

  private async writeAll(map: Record<string, VaultRecord>): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(map, null, 2), { mode: 0o600 });
  }

  private deriveKey(pass: string, salt: Buffer): Buffer {
    return scryptSync(pass, salt, 32);
  }

  async get(ref: string): Promise<string | null> {
    const map = await this.readAll();
    const rec = map[ref];
    if (!rec) return null;
    const pass = await this.getPassphrase();
    if (!pass) return null;
    try {
      const salt = Buffer.from(rec.salt, "base64");
      const iv = Buffer.from(rec.iv, "base64");
      const tag = Buffer.from(rec.tag, "base64");
      const key = this.deriveKey(pass, salt);
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      const out = Buffer.concat([decipher.update(Buffer.from(rec.ct, "base64")), decipher.final()]);
      return out.toString("utf8");
    } catch (e) {
      throw new NexusError("secret_backend", `failed to decrypt secret "${ref}" (wrong passphrase?)`, {
        cause: e,
      });
    }
  }

  async has(ref: string): Promise<boolean> {
    const map = await this.readAll();
    return map[ref] !== undefined;
  }

  async set(ref: string, value: string): Promise<void> {
    const pass = await this.getPassphrase();
    if (!pass) {
      throw new NexusError(
        "secret_backend",
        "no vault passphrase available (set NEXUS_VAULT_PASSPHRASE) to use the encrypted-file secret backend",
      );
    }
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = this.deriveKey(pass, salt);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
    const tag = cipher.getAuthTag();
    const map = await this.readAll();
    map[ref] = {
      v: 1,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      ct: ct.toString("base64"),
      tag: tag.toString("base64"),
    };
    await this.writeAll(map);
  }

  async delete(ref: string): Promise<boolean> {
    const map = await this.readAll();
    if (map[ref] === undefined) return false;
    delete map[ref];
    if (Object.keys(map).length === 0) {
      await rm(this.filePath, { force: true });
    } else {
      await this.writeAll(map);
    }
    return true;
  }
}

// ── Chain ────────────────────────────────────────────────────────────────────

export interface SecretChainOptions {
  /** Environment source (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Map a logical ref to its env var name; default `<REF>_API_KEY` upper-cased. */
  envVarFor?: (ref: string) => string | undefined;
  /** Keychain service/namespace (default "nexuscode"). */
  service?: string;
  /** Encrypted-vault path (default under the platform data dir). */
  filePath?: string;
  /** Vault passphrase, or a resolver; default reads `NEXUS_VAULT_PASSPHRASE`. */
  passphrase?: string | (() => Promise<string | null>);
  /** Disable the keychain backend (e.g. for deterministic tests). */
  disableKeychain?: boolean;
}

function defaultEnvVarFor(ref: string): string {
  return `${ref.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

class ChainedSecretStore implements SecretStore {
  constructor(
    private readonly env: EnvBackend,
    private readonly keychain: KeychainBackend | null,
    private readonly file: EncryptedFileBackend,
  ) {}

  async get(ref: string): Promise<string | null> {
    const fromEnv = this.env.get(ref);
    if (fromEnv) return fromEnv;
    if (this.keychain) {
      const fromKc = await this.keychain.get(ref);
      if (fromKc) return fromKc;
    }
    return this.file.get(ref);
  }

  async source(ref: string): Promise<SecretSource | null> {
    if (this.env.get(ref)) return "env";
    if (this.keychain && (await this.keychain.get(ref))) return "keychain";
    if (await this.file.has(ref)) return "file";
    return null;
  }

  async set(ref: string, value: string): Promise<void> {
    if (this.keychain && (await this.keychain.set(ref, value))) return;
    await this.file.set(ref, value);
  }

  async delete(ref: string): Promise<void> {
    if (this.keychain) await this.keychain.delete(ref);
    await this.file.delete(ref);
  }
}

export function createSecretStore(opts: SecretChainOptions = {}): SecretStore {
  const env = opts.env ?? process.env;
  const envVarFor = opts.envVarFor ?? defaultEnvVarFor;
  const service = opts.service ?? "nexuscode";
  const filePath = opts.filePath ?? nexusPaths().secretsFile;

  const getPassphrase = async (): Promise<string | null> => {
    if (typeof opts.passphrase === "function") return opts.passphrase();
    if (typeof opts.passphrase === "string") return opts.passphrase;
    return env["NEXUS_VAULT_PASSPHRASE"] ?? null;
  };

  const keychain = opts.disableKeychain ? null : new KeychainBackend(service);
  return new ChainedSecretStore(
    new EnvBackend(env, envVarFor),
    keychain,
    new EncryptedFileBackend(filePath, getPassphrase),
  );
}
