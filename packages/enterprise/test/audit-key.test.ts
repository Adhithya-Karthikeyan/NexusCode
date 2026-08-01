/**
 * Audit HMAC-key path tests (ENT-01, ENT-03): `resolveAuditKey` generates AND
 * persists a durable key through the SecretStore so a chain built by one
 * process verifies in the next; `auditKeyRef` scopes distinct audit files to
 * distinct refs; and `buildEnterpriseServices` pins its actual (unsafe)
 * behavior when two instances share an `auditFile` without a shared,
 * persistent `auditKey`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSecretStore, type SecretStore } from "@nexuscode/config";
import { AuditLog, auditKeyRef, resolveAuditKey, DEFAULT_AUDIT_KEY_REF } from "../src/index.js";
import { buildEnterpriseServices } from "../src/wire/index.js";

// Every root `vaultStore()` mkdtemps, so they can all be drained together once
// at the end of the file instead of tracking each call site individually.
const vaultRoots: string[] = [];

function vaultStore(): SecretStore {
  const root = mkdtempSync(join(tmpdir(), "nx-ent-key-"));
  vaultRoots.push(root);
  const file = join(root, "secrets.enc.json");
  // Encrypted-file backend (no keychain) so tests never GUI-block.
  return createSecretStore({ env: {}, disableKeychain: true, filePath: file, passphrase: "pw" });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nx-ent-audit-key-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
afterAll(() => {
  for (const root of vaultRoots) rmSync(root, { recursive: true, force: true });
});

describe("resolveAuditKey", () => {
  it("generates and persists a 32-byte key on first use, and returns the SAME key on a later call", async () => {
    const secrets = vaultStore();
    const ref = auditKeyRef();

    const first = await resolveAuditKey(secrets, ref);
    expect(first).toBeInstanceOf(Buffer);
    expect(first).toHaveLength(32);
    // Persisted through the store under `ref` (hex-encoded).
    const stored = await secrets.get(ref);
    expect(stored).toBe(first.toString("hex"));

    const second = await resolveAuditKey(secrets, ref);
    expect(second.equals(first)).toBe(true);
  });

  it("defaults to DEFAULT_AUDIT_KEY_REF when no ref is given", async () => {
    const secrets = vaultStore();
    const key = await resolveAuditKey(secrets);
    expect(await secrets.get(DEFAULT_AUDIT_KEY_REF)).toBe(key.toString("hex"));
  });
});

describe("auditKeyRef", () => {
  it("scopes distinct audit files to distinct refs", () => {
    const a = auditKeyRef("/var/nexus/audit-a.ndjson");
    const b = auditKeyRef("/var/nexus/audit-b.ndjson");
    expect(a).not.toBe(b);
    expect(a).toBe(`${DEFAULT_AUDIT_KEY_REF}:/var/nexus/audit-a.ndjson`);
  });

  it("falls back to DEFAULT_AUDIT_KEY_REF when no file is given", () => {
    expect(auditKeyRef()).toBe(DEFAULT_AUDIT_KEY_REF);
    expect(auditKeyRef(undefined)).toBe(DEFAULT_AUDIT_KEY_REF);
  });
});

describe("cross-process contract: resolveAuditKey + AuditLog", () => {
  it("a fresh AuditLog resolving the same ref verifies a chain built by an earlier process", async () => {
    const secrets = vaultStore();
    const file = join(dir, "audit.ndjson");
    const ref = auditKeyRef(file);

    // "Process 1": resolve the key, build the chain.
    const key1 = await resolveAuditKey(secrets, ref);
    const log1 = new AuditLog({ file, key: key1 });
    log1.append({ actor: "alice", action: "run.start" });
    log1.append({ actor: "alice", action: "run.end" });
    expect(log1.verifyFile().ok).toBe(true);

    // "Process 2": a brand-new AuditLog instance resolving the SAME ref from
    // the SAME store must derive the identical key and see a clean chain.
    const key2 = await resolveAuditKey(secrets, ref);
    expect(key2.equals(key1)).toBe(true);
    const log2 = new AuditLog({ file, key: key2 });
    expect(log2.all()).toHaveLength(2);
    expect(log2.verifyFile()).toEqual({ ok: true, count: 2, tampered: [] });

    // A byte-level tamper to a committed line is still caught.
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const tampered = JSON.parse(lines[1] as string) as { actor: string };
    tampered.actor = "mallory";
    lines[1] = JSON.stringify(tampered);
    writeFileSync(file, `${lines.join("\n")}\n`);

    const log3 = new AuditLog({ file, key: await resolveAuditKey(secrets, ref) });
    const verdict = log3.verifyFile();
    expect(verdict.ok).toBe(false);
    expect(verdict.tampered.some((t) => t.reason === "hash-mismatch")).toBe(true);
  });
});

describe("wire contract (ENT-03): buildEnterpriseServices auditKey default", () => {
  it("two instances over the SAME auditFile withOUT a shared auditKey do NOT produce a chain that verifies together", () => {
    // Pinning actual (unsafe-by-default) behavior: `opts.auditKey` defaults to
    // a fresh per-instance `randomBytes(32)` (wire/services.ts), so a second
    // process/instance that omits `auditKey` cannot authenticate records the
    // first instance wrote — callers MUST pass a persistent, resolveAuditKey-
    // derived key when `auditFile` is set for the chain to survive a restart.
    const file = join(dir, "wire-audit.ndjson");

    const svc1 = buildEnterpriseServices({ mode: "on" }, { auditFile: file });
    svc1.audit({ actor: "alice", action: "run.start" });
    svc1.audit({ actor: "alice", action: "run.end" });
    expect(svc1.auditLog.verifyFile().ok).toBe(true);

    // A second bundle over the same file, built without `opts.auditKey`, gets
    // its own independent random key.
    const svc2 = buildEnterpriseServices({ mode: "on" }, { auditFile: file });
    // It still loads the prior records from disk...
    expect(svc2.auditLog.all()).toHaveLength(2);
    // ...but cannot authenticate them under its own (different) key: the
    // pre-existing records fail hash verification.
    const verdict = svc2.auditLog.verifyFile();
    expect(verdict.ok).toBe(false);
    expect(verdict.tampered.some((t) => t.reason === "hash-mismatch")).toBe(true);

    // Passing a shared, persistent key (the fix) makes the two instances
    // agree instead.
    const SHARED_KEY = Buffer.from("cc".repeat(32), "hex");
    const file2 = join(dir, "wire-audit-shared.ndjson");
    const shared1 = buildEnterpriseServices({ mode: "on" }, { auditFile: file2, auditKey: SHARED_KEY });
    shared1.audit({ actor: "alice", action: "run.start" });
    const shared2 = buildEnterpriseServices({ mode: "on" }, { auditFile: file2, auditKey: SHARED_KEY });
    expect(shared2.auditLog.verifyFile()).toEqual({ ok: true, count: 1, tampered: [] });
  });
});
