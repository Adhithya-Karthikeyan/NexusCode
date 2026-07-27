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

/**
 * Bound for a single native keychain call (`getPassword`/`setPassword`/
 * `deletePassword`). These go straight through `@napi-rs/keyring` into the
 * OS's real credential store (Keychain Services on macOS) — for an item that
 * exists but was written by a DIFFERENT signed binary (a rebuilt dev binary,
 * a different terminal's responsible process, …), reading it back requires a
 * fresh authorization decision, which macOS presents as a system dialog:
 * "[app] wants to use your confidential information stored in […] in your
 * keychain." Nothing here runs interactively — `resolveAuthSecrets` calls
 * into this on EVERY command (`buildAuthedRuntime` unconditionally probes the
 * default provider catalog's credential status, regardless of which provider
 * `-p` actually selects), including headless/dispatched runs with no one to
 * click "Allow". A blocked native call is indistinguishable from the outside
 * from every other unbounded-I/O hang this codebase has already had to fix
 * (`DEFAULT_CONNECT_TIMEOUT_MS` in `@nexuscode/mcp`, `DEFAULT_SOURCE_TIMEOUT_MS`
 * in `@nexuscode/context`): the whole run blocks forever with no output. Same
 * fix shape: race the call against a bound and degrade to "unavailable"
 * (exactly how a genuine platform/NoEntry error already degrades below)
 * instead of hanging.
 */
export const DEFAULT_KEYCHAIN_TIMEOUT_MS = 5_000;

/**
 * Race `work` against `ms`, resolving to `fallback` (never rejecting) on
 * timeout. Reports whether it actually timed out — distinct from a genuine
 * (fast) rejection/resolution to `fallback` — so a caller can tell "the OS
 * said no" (unremarkable, already handled below) apart from "the OS never
 * answered" (worth a diagnostic; see `keychainTimeoutMessage`).
 */
function withTimeout<T>(work: Promise<T>, ms: number, fallback: T): Promise<{ value: T; timedOut: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ value: fallback, timedOut: true });
    }, ms);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ value, timedOut: false });
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ value: fallback, timedOut: false });
      },
    );
  });
}

/**
 * The diagnostic for a keychain call that hit `DEFAULT_KEYCHAIN_TIMEOUT_MS`
 * (or a caller-supplied override) — printed to stderr, never silent, so
 * "why did my key stop being found" doesn't send the next person hunting
 * through the retry/dedupe/network code a plain "timed out" would imply.
 * `op` is the verb that timed out ("read"/"write"/"delete"); `ref` is the
 * logical secret name (e.g. "anthropic"), not the resolved key value.
 */
function keychainTimeoutMessage(op: string, ref: string, ms: number): string {
  return (
    `secrets: keychain ${op} for "${ref}" timed out after ${ms}ms — most likely macOS is waiting ` +
    `on an authorization prompt this process cannot display (a stored item whose reading process ` +
    `has not been granted access blocks exactly like this, indefinitely, with no dialog visible in ` +
    `a headless/dispatched run); falling back to the encrypted file store\n`
  );
}

/**
 * Exported for tests only (the `loadCtor` injection seam has no reason to be
 * used outside one) — real callers go through `createSecretStore`.
 */
export class KeychainBackend {
  private ctor: KeyringEntryCtor | null | undefined;
  private readonly timeoutMs: number;

  /**
   * `loadCtor` is exposed for tests only — real callers always get the
   * genuine `@napi-rs/keyring` loader below. Lets a test inject a fake
   * `KeyringEntry` (e.g. one whose `getPassword()` never resolves) without
   * touching the real OS keychain.
   */
  constructor(
    private readonly service: string,
    opts: { timeoutMs?: number; loadCtor?: () => Promise<KeyringEntryCtor | null> } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_KEYCHAIN_TIMEOUT_MS;
    if (opts.loadCtor) this.loadCtor = opts.loadCtor;
  }

  private loadCtor = async (): Promise<KeyringEntryCtor | null> => {
    try {
      const mod = (await import("@napi-rs/keyring")) as { AsyncEntry?: KeyringEntryCtor };
      return typeof mod.AsyncEntry === "function" ? mod.AsyncEntry : null;
    } catch {
      return null;
    }
  };

  private async load(): Promise<KeyringEntryCtor | null> {
    if (this.ctor !== undefined) return this.ctor;
    this.ctor = await this.loadCtor();
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
      const { value: v, timedOut } = await withTimeout(e.getPassword(), this.timeoutMs, undefined);
      if (timedOut) process.stderr.write(keychainTimeoutMessage("read", ref, this.timeoutMs));
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
      // `withTimeout` never rejects, so a timeout here reports `false` — the
      // caller (`ChainedSecretStore.set`) already falls through to the
      // encrypted-file backend on `false`, exactly like a genuine write
      // failure. `ok` distinguishes "genuinely wrote" from "gave up waiting".
      const { value: ok, timedOut } = await withTimeout(
        e.setPassword(value).then(() => true),
        this.timeoutMs,
        false,
      );
      if (timedOut) process.stderr.write(keychainTimeoutMessage("write", ref, this.timeoutMs));
      return ok;
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
      const { value: ok, timedOut } = await withTimeout(e.deletePassword(), this.timeoutMs, false);
      if (timedOut) process.stderr.write(keychainTimeoutMessage("delete", ref, this.timeoutMs));
      return ok;
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
  /** Bound for a single native keychain call (default {@link DEFAULT_KEYCHAIN_TIMEOUT_MS}). */
  keychainTimeoutMs?: number;
  /**
   * Exported for tests only — injects `KeychainBackend`'s native-entry loader
   * so a test can exercise the FULL `createSecretStore` chain against a fake
   * (e.g. never-resolving) keychain without touching the real OS keychain.
   */
  keychainLoadCtor?: () => Promise<(new (service: string, username: string) => KeyringEntry) | null>;
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

  const keychain = opts.disableKeychain
    ? null
    : new KeychainBackend(service, {
        ...(opts.keychainTimeoutMs !== undefined ? { timeoutMs: opts.keychainTimeoutMs } : {}),
        ...(opts.keychainLoadCtor ? { loadCtor: opts.keychainLoadCtor } : {}),
      });
  return new ChainedSecretStore(
    new EnvBackend(env, envVarFor),
    keychain,
    new EncryptedFileBackend(filePath, getPassphrase),
  );
}
