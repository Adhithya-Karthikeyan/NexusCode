/**
 * Audit-log tests: records hash-chain correctly; verify() detects a tampered
 * record (mutated field, altered hash, reorder, deletion); secrets are redacted
 * out of both the stored record and the hash input; the NDJSON file is written
 * with owner-only perms and re-reads/verifies from disk; the query API filters
 * by actor/action/time; and the chain is HMAC-keyed so it cannot be forged
 * without the key — a signed head anchor additionally catches tail-truncation,
 * and a failed persist fails closed (no in-memory/on-disk gap).
 */

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuditLog,
  GENESIS_HASH,
  REDACTED,
  computeHash,
  readNdjsonRecords,
  verifyChain,
  type AuditRecord,
} from "../src/index.js";

/** Fixed HMAC key for deterministic tests (never used outside this file). */
const TEST_KEY = Buffer.from("aa".repeat(32), "hex");
const OTHER_KEY = Buffer.from("bb".repeat(32), "hex");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nx-audit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("audit hash-chain", () => {
  it("chains records: first links to genesis, each links to the prior hash", () => {
    const log = new AuditLog({ key: TEST_KEY });
    const a = log.append({ actor: "alice", action: "auth.login", decision: "success" });
    const b = log.append({ actor: "alice", action: "run.start", resource: "run-1" });
    const c = log.append({ actor: "alice", action: "run.end", resource: "run-1" });

    expect(a.seq).toBe(0);
    expect(a.prevHash).toBe(GENESIS_HASH);
    expect(b.prevHash).toBe(a.hash);
    expect(c.prevHash).toBe(b.hash);
    // hash is reproducible from content, under the same key.
    const { hash, ...hashable } = a;
    expect(computeHash(hashable, TEST_KEY)).toBe(hash);

    expect(log.verify()).toEqual({ ok: true, count: 3, tampered: [] });
  });

  it("verify() detects a tampered field", () => {
    const log = new AuditLog({ key: TEST_KEY });
    log.append({ actor: "alice", action: "tool.call", resource: "bash" });
    log.append({ actor: "bob", action: "tool.approval", resource: "bash", decision: "deny" });

    const records = log.all();
    // Mutate content but keep the (now stale) hash -> hash-mismatch.
    (records[1] as { decision: string }).decision = "allow";
    const result = verifyChain(records, TEST_KEY);
    expect(result.ok).toBe(false);
    expect(result.tampered.some((t) => t.reason === "hash-mismatch")).toBe(true);
  });

  it("verify() detects a forged hash", () => {
    const log = new AuditLog({ key: TEST_KEY });
    log.append({ actor: "alice", action: "config.change", resource: "model" });
    log.append({ actor: "alice", action: "config.change", resource: "budget" });
    const records = log.all();
    (records[1] as { hash: string }).hash = "f".repeat(64);
    const result = verifyChain(records, TEST_KEY);
    expect(result.ok).toBe(false);
    // Recomputed hash won't match the forged one, and the next link would break too.
    expect(result.tampered.some((t) => t.reason === "hash-mismatch")).toBe(true);
  });

  it("verify() detects a deleted (dropped) record", () => {
    const log = new AuditLog({ key: TEST_KEY });
    log.append({ actor: "a", action: "run.start" });
    log.append({ actor: "a", action: "tool.call" });
    log.append({ actor: "a", action: "run.end" });
    const records = log.all();
    records.splice(1, 1); // drop the middle record
    const result = verifyChain(records, TEST_KEY);
    expect(result.ok).toBe(false);
    // seq gap and broken prev-hash link.
    expect(result.tampered.some((t) => t.reason === "prev-hash-mismatch")).toBe(true);
    expect(result.tampered.some((t) => t.reason === "seq-mismatch")).toBe(true);
  });

  it("verify() detects reordering", () => {
    const log = new AuditLog({ key: TEST_KEY });
    log.append({ actor: "a", action: "run.start" });
    log.append({ actor: "a", action: "run.end" });
    const records = log.all();
    [records[0], records[1]] = [records[1]!, records[0]!];
    expect(verifyChain(records, TEST_KEY).ok).toBe(false);
  });

  it("verify() fails without the key (wrong key cannot authenticate the chain)", () => {
    const log = new AuditLog({ key: TEST_KEY });
    log.append({ actor: "a", action: "run.start" });
    log.append({ actor: "a", action: "run.end" });
    expect(verifyChain(log.all(), OTHER_KEY).ok).toBe(false);
  });

  it("detects a full-rewrite of the chain performed WITHOUT the HMAC key", () => {
    // An attacker with file-write access but not the key: recompute the whole
    // chain from genesis using a different key (an unkeyed SHA-256 chain would
    // verify perfectly here — that's exactly the hole HMAC-keying closes).
    const file = join(dir, "audit.ndjson");
    const log = new AuditLog({ file, key: TEST_KEY });
    log.append({ actor: "alice", action: "auth.login" });
    log.append({ actor: "alice", action: "run.start", resource: "r1" });
    log.append({ actor: "alice", action: "run.end", resource: "r1" });

    const original = readNdjsonRecords(file);
    let prev = GENESIS_HASH;
    const rewritten: AuditRecord[] = original.map((r) => {
      const { hash: _old, ...rest } = r;
      const base = { ...rest, prevHash: prev };
      const hash = computeHash(base, OTHER_KEY); // attacker's guess, not the real key
      prev = hash;
      return { ...base, hash };
    });
    writeFileSync(file, `${rewritten.map((r) => JSON.stringify(r)).join("\n")}\n`);

    const reopened = new AuditLog({ file, key: TEST_KEY });
    expect(reopened.verifyFile().ok).toBe(false);
  });
});

describe("audit redaction", () => {
  it("redacts secrets in details, actor and resource before storing/hashing", () => {
    const log = new AuditLog({ key: TEST_KEY });
    const rec = log.append({
      actor: "user token=sk-ABCDEF0123456789ABCDEF",
      action: "provider.key_access",
      resource: "openai",
      details: {
        api_key: "sk-SUPERSECRETVALUE0000000",
        note: "authorization: Bearer abcdefghijklmnop1234567890",
        nested: { password: "hunter2hunter2" },
      },
    });

    const serialized = JSON.stringify(rec);
    expect(serialized).not.toContain("sk-SUPERSECRETVALUE0000000");
    expect(serialized).not.toContain("sk-ABCDEF0123456789ABCDEF");
    expect(serialized).not.toContain("hunter2hunter2");
    expect((rec.details as { api_key: string }).api_key).toBe(REDACTED);
    expect((rec.details as { nested: { password: string } }).nested.password).toBe(REDACTED);
    // The record still verifies (redaction happened before hashing).
    expect(log.verify().ok).toBe(true);
  });
});

describe("audit persistence", () => {
  it("appends NDJSON with owner-only perms and reloads a verifiable chain", () => {
    const file = join(dir, "audit.ndjson");
    const log = new AuditLog({ file, key: TEST_KEY });
    log.append({ actor: "alice", action: "auth.login", decision: "success" });
    log.append({ actor: "alice", action: "run.start", resource: "r1" });
    log.append({ actor: "bob", action: "rbac.decision", resource: "admin", decision: "deny" });

    expect(existsSync(file)).toBe(true);
    // Owner-only perms (0600). Mask off the file-type bits.
    const mode = statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
    // The signed head anchor is a SEPARATE file, also owner-only.
    const anchorMode = statSync(`${file}.anchor.json`).mode & 0o777;
    expect(anchorMode).toBe(0o600);

    const onDisk = readNdjsonRecords(file);
    expect(onDisk).toHaveLength(3);
    expect(verifyChain(onDisk, TEST_KEY).ok).toBe(true);

    // A fresh log loading the same file + key sees the whole chain and can
    // append on top.
    const reopened = new AuditLog({ file, key: TEST_KEY });
    expect(reopened.all()).toHaveLength(3);
    const next = reopened.append({ actor: "alice", action: "run.end", resource: "r1" });
    expect(next.seq).toBe(3);
    expect(reopened.verifyFile().ok).toBe(true);
  });

  it("verifyFile() detects an out-of-band edit to the NDJSON file", () => {
    const file = join(dir, "audit.ndjson");
    const log = new AuditLog({ file, key: TEST_KEY });
    log.append({ actor: "alice", action: "config.change", resource: "model" });
    log.append({ actor: "alice", action: "config.change", resource: "budget" });

    // Tamper directly on disk: flip a field in the last line, keep its hash.
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    const parsed = JSON.parse(lines[1]!) as { resource: string };
    parsed.resource = "unlimited";
    lines[1] = JSON.stringify(parsed);
    writeFileSync(file, `${lines.join("\n")}\n`);

    expect(log.verifyFile().ok).toBe(false);
  });

  it("verifyFile() detects TRUNCATION (dropped tail records) via the signed head anchor", () => {
    const file = join(dir, "audit.ndjson");
    const log = new AuditLog({ file, key: TEST_KEY });
    log.append({ actor: "alice", action: "run.start" });
    log.append({ actor: "alice", action: "tool.call" });
    log.append({ actor: "alice", action: "run.end" });
    expect(log.verifyFile().ok).toBe(true);

    // Drop the last record out-of-band. The remaining prefix is STILL a
    // perfectly valid HMAC chain (every hash was legitimately computed by the
    // real key) — only the signed anchor (which still expects 3 records)
    // catches the truncation.
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    lines.pop();
    writeFileSync(file, `${lines.join("\n")}\n`);
    expect(verifyChain(readNdjsonRecords(file), TEST_KEY).ok).toBe(true); // the hash chain alone looks fine

    const result = log.verifyFile();
    expect(result.ok).toBe(false);
    expect(result.tampered.some((t) => t.reason === "anchor-mismatch")).toBe(true);
  });

  it("verifyFile() detects DELETION of the whole chain file via the signed head anchor", () => {
    // The highest-value attack on a tamper-evident log is not editing it — it
    // is removing it. `rm audit.ndjson` leaves the signed anchor behind still
    // asserting a record count, so this must report exactly like any other
    // truncation, NOT as a clean chain.
    const file = join(dir, "audit.ndjson");
    const log = new AuditLog({ file, key: TEST_KEY });
    log.append({ actor: "alice", action: "run.start" });
    log.append({ actor: "alice", action: "run.end" });
    expect(log.verifyFile().ok).toBe(true);

    rmSync(file);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.anchor.json`)).toBe(true);

    // A freshly opened log (the `nexus audit --verify` path — a new process
    // that loads nothing because there is nothing to load) must still fail.
    const reopened = new AuditLog({ file, key: TEST_KEY });
    const result = reopened.verifyFile();
    expect(result.ok).toBe(false);
    expect(result.tampered.some((t) => t.reason === "anchor-mismatch")).toBe(true);
    expect(result.tampered[0]?.detail).toMatch(/expects 2 record\(s\)/);
    expect(result.tampered[0]?.detail).toMatch(/MISSING \(deleted\)/);
  });

  it("verifyFile() reports a FRESH install (no anchor, no file) as clean", () => {
    // The counterpart guard: a first run has neither file nor anchor and must
    // never look tampered.
    const file = join(dir, "does-not-exist-yet.ndjson");
    const log = new AuditLog({ file, key: TEST_KEY });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(`${file}.anchor.json`)).toBe(false);
    expect(log.verifyFile()).toEqual({ ok: true, count: 0, tampered: [] });
  });

  it("verifyFile() detects a zero-byte chain file (same finding as deletion)", () => {
    const file = join(dir, "audit.ndjson");
    const log = new AuditLog({ file, key: TEST_KEY });
    log.append({ actor: "alice", action: "run.start" });
    log.append({ actor: "alice", action: "run.end" });

    writeFileSync(file, "");
    const result = log.verifyFile();
    expect(result.ok).toBe(false);
    expect(result.tampered.some((t) => t.reason === "anchor-mismatch")).toBe(true);
  });

  it("verifyFile() detects the anchor itself being forged without the key", () => {
    const file = join(dir, "audit.ndjson");
    const log = new AuditLog({ file, key: TEST_KEY });
    log.append({ actor: "alice", action: "run.start" });
    log.append({ actor: "alice", action: "run.end" });

    // Drop the last record AND try to forge a matching anchor without the key.
    const lines = readFileSync(file, "utf8").trimEnd().split("\n");
    lines.pop();
    writeFileSync(file, `${lines.join("\n")}\n`);
    const forgedAnchor = { count: 1, head: (readNdjsonRecords(file)[0] as AuditRecord).hash, sig: "deadbeef" };
    writeFileSync(`${file}.anchor.json`, JSON.stringify(forgedAnchor));

    expect(log.verifyFile().ok).toBe(false);
  });

  it("append() fails closed on a persistence error — no in-memory/on-disk gap", () => {
    const file = join(dir, "audit.ndjson");
    const log = new AuditLog({ file, key: TEST_KEY });
    log.append({ actor: "alice", action: "auth.login" });
    expect(log.all()).toHaveLength(1);

    // Make the file unwritable so the next append's persist fails.
    chmodSync(file, 0o400);
    let threw = false;
    try {
      log.append({ actor: "alice", action: "run.start" });
    } catch {
      threw = true;
    } finally {
      chmodSync(file, 0o600); // restore so temp-dir cleanup can remove it
    }
    expect(threw).toBe(true);
    // The in-memory head did NOT advance — no gap between "committed" and persisted.
    expect(log.all()).toHaveLength(1);
    expect(log.verify().ok).toBe(true);
    expect(readNdjsonRecords(file)).toHaveLength(1);
  });
});

describe("audit query", () => {
  it("filters by actor, action and time window", () => {
    const log = new AuditLog({ key: TEST_KEY });
    log.append({ actor: "alice", action: "auth.login", ts: 1000 });
    log.append({ actor: "bob", action: "tool.call", ts: 2000 });
    log.append({ actor: "alice", action: "tool.call", ts: 3000 });
    log.append({ actor: "alice", action: "run.end", ts: 4000 });

    expect(log.query({ actor: "alice" })).toHaveLength(3);
    expect(log.query({ action: "tool.call" })).toHaveLength(2);
    expect(log.query({ actor: "alice", action: "tool.call" })).toHaveLength(1);
    expect(log.query({ actions: ["auth.login", "run.end"] })).toHaveLength(2);
    expect(log.query({ from: 2000, to: 3000 })).toHaveLength(2);
    expect(log.query({ from: 2000, to: 3000 }).map((r) => r.actor)).toEqual(["bob", "alice"]);
  });
});
