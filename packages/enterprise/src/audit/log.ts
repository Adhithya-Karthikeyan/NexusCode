/**
 * AuditLog — an append-only, redacted, tamper-evident record of security-
 * relevant events (system-spec §25 / §18). Records are HMAC-hash-chained
 * (keyed — see `hashchain.ts`); secrets are scrubbed *before* a record is
 * committed (so no credential enters the store or the hash input); optional
 * NDJSON persistence is written with owner-only perms (0600) and the file
 * itself is append-only from this API's perspective — `append()` only ever
 * adds a line, never rewrites earlier ones.
 *
 * Two extra tamper-evidence properties beyond a bare hash chain:
 *
 *  - A signed HEAD ANCHOR (latest hash + record count), persisted to a
 *    SEPARATE file, catches tail-TRUNCATION: deleting the last N records
 *    still leaves a perfectly valid (shorter) hash chain, so replay alone
 *    can't detect it — the anchor's count/head must also match.
 *  - Fail-closed persistence: the NDJSON line (and the anchor) are written
 *    and fsync'd BEFORE the in-memory head advances, so a failed write throws
 *    out of `append()` with the in-memory log untouched — never a silent gap
 *    between what the caller thinks was committed and what's actually on disk.
 */

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { createHmac } from "node:crypto";
import { dirname } from "node:path";
import { REDACTED, redactArgs, redactSecrets } from "@nexuscode/tools";
import { AUDIT_RECORD_VERSION, GENESIS_HASH, computeHash } from "./hashchain.js";
import type {
  AuditInput,
  AuditQuery,
  AuditRecord,
  AuditTamper,
  AuditVerifyResult,
} from "./types.js";

export interface AuditLogOptions {
  /** NDJSON file to persist to. Omit for a purely in-memory log. */
  file?: string;
  /** Load existing records from `file` on construction. Default true. */
  load?: boolean;
  /**
   * HMAC-SHA256 key chaining this log — REQUIRED. Resolve one via
   * `resolveAuditKey` (backed by the SecretStore, generated + persisted on
   * first use, NOT co-located with `file`); an unkeyed chain is exactly the
   * forgeability hole this module closes (see `hashchain.ts`).
   */
  key: Buffer | string;
  /**
   * Path for the signed head-anchor file (latest hash + record count), which
   * catches tail-truncation a hash-chain replay alone cannot. Defaults to
   * `${file}.anchor.json`. Ignored for a purely in-memory log (no `file`).
   */
  anchorFile?: string;
}

/** The signed head anchor persisted alongside a file-backed log. */
interface AuditAnchor {
  /** Expected total record count. */
  count: number;
  /** Expected hash of the last record (GENESIS_HASH when `count` is 0). */
  head: string;
  /** HMAC-SHA256(key, `${count}:${head}`) — proves the anchor itself wasn't forged. */
  sig: string;
}

export class AuditLog {
  private readonly records: AuditRecord[] = [];
  private readonly file?: string;
  private readonly anchorFile?: string;
  private readonly key: Buffer | string;

  constructor(opts: AuditLogOptions) {
    this.key = opts.key;
    if (opts.file !== undefined) {
      this.file = opts.file;
      this.anchorFile = opts.anchorFile ?? `${opts.file}.anchor.json`;
    }
    if (this.file && (opts.load ?? true) && existsSync(this.file)) {
      for (const rec of readNdjsonRecords(this.file)) this.records.push(rec);
    }
  }

  /** Hash of the most recently committed record (GENESIS_HASH when empty). */
  private get headHash(): string {
    const last = this.records[this.records.length - 1];
    return last ? last.hash : GENESIS_HASH;
  }

  /**
   * Redact, chain and commit an event. Returns the committed record. String
   * fields (`actor`, `resource`, `sessionId`) get value-shape scrubbing; the
   * `details` bag gets full key-name + value redaction. Redaction happens before
   * hashing, so the chain is over already-clean data.
   *
   * Fail-closed: when this log is file-backed, the record is written (+
   * fsync'd) to disk BEFORE the in-memory head advances. A persistence
   * failure throws out of this method and the in-memory log is left
   * unchanged — there is never a gap where the caller believes a record
   * committed but the file (or the file but not the anchor) disagrees.
   */
  append(input: AuditInput): AuditRecord {
    const seq = this.records.length;
    const prevHash = this.headHash;

    const base: Omit<AuditRecord, "hash"> = {
      v: AUDIT_RECORD_VERSION,
      seq,
      ts: input.ts ?? Date.now(),
      actor: redactSecrets(input.actor),
      action: input.action,
      decision: input.decision ?? "info",
      prevHash,
    };
    if (input.role !== undefined) base.role = redactSecrets(input.role);
    if (input.resource !== undefined) base.resource = redactSecrets(input.resource);
    if (input.sessionId !== undefined) base.sessionId = redactSecrets(input.sessionId);
    if (input.details !== undefined) {
      base.details = redactArgs(input.details) as Record<string, unknown>;
    }

    const record: AuditRecord = { ...base, hash: computeHash(base, this.key) };

    if (this.file) this.persist(record); // may throw — see fail-closed note above
    this.records.push(record);
    return record;
  }

  /** All committed records, in commit order (defensive copy). */
  all(): AuditRecord[] {
    return this.records.slice();
  }

  /** Query the log. All conditions AND together. */
  query(q: AuditQuery = {}): AuditRecord[] {
    return this.records.filter((r) => {
      if (q.actor !== undefined && r.actor !== q.actor) return false;
      if (q.action !== undefined && r.action !== q.action) return false;
      if (q.actions !== undefined && !q.actions.includes(r.action)) return false;
      if (q.role !== undefined && r.role !== q.role) return false;
      if (q.resource !== undefined && r.resource !== q.resource) return false;
      if (q.decision !== undefined && r.decision !== q.decision) return false;
      if (q.from !== undefined && r.ts < q.from) return false;
      if (q.to !== undefined && r.ts > q.to) return false;
      return true;
    });
  }

  /** Verify this log's in-memory chain. */
  verify(): AuditVerifyResult {
    return verifyChain(this.records, this.key);
  }

  /**
   * Verify the chain as persisted on disk (re-reads the NDJSON file), AND
   * that its tail matches the signed head anchor. Detects out-of-band edits
   * to the file that never went through `append()` — including a
   * tail-truncation, which is still a perfectly valid (shorter) hash chain
   * and so is only caught by the anchor.
   *
   * A MISSING chain file is NOT automatically clean. Deleting the whole log is
   * the highest-value attack on a tamper-evident record, and it is precisely
   * what the anchor exists to catch: a signed anchor asserting `count:N` with
   * zero recoverable records is a total truncation, reported exactly like the
   * zero-byte-file case. Only a fresh install — NO anchor and NO file, nothing
   * ever appended — verifies clean.
   */
  verifyFile(): AuditVerifyResult {
    if (!this.file || !existsSync(this.file)) return { ok: true, count: 0, tampered: [] };
    const fileMissing = !existsSync(this.file);
    const records = fileMissing ? [] : readNdjsonRecords(this.file);
    const result = verifyChain(records, this.key);
    const anchorTamper = this.checkAnchor(records, { fileMissing });
    if (anchorTamper) {
      result.tampered.push(anchorTamper);
      result.ok = false;
    }
    return result;
  }

  private signAnchor(count: number, head: string): string {
    return createHmac("sha256", this.key).update(`${count}:${head}`).digest("hex");
  }

  /** Persist the signed head anchor (overwrites — it holds only the latest state). */
  private persistAnchor(count: number, head: string): void {
    const path = this.anchorFile as string;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const anchor: AuditAnchor = { count, head, sig: this.signAnchor(count, head) };
    const fd = openSync(path, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(anchor));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(path, 0o600);
  }

  /**
   * Compare the on-disk anchor against the actual (re-read) record tail.
   * `fileMissing` distinguishes "the chain file was deleted outright" from
   * "the chain file is present but short", so the finding names what happened.
   */
  private checkAnchor(
    records: readonly AuditRecord[],
    opts: { fileMissing?: boolean } = {},
  ): AuditTamper | null {
    const path = this.anchorFile as string;
    if (!existsSync(path)) {
      return records.length > 0
        ? {
            seq: records.length - 1,
            reason: "anchor-mismatch",
            detail: `expected a signed head anchor at ${path} (missing — possible truncation or rollback)`,
          }
        : null;
    }
    let anchor: AuditAnchor;
    try {
      anchor = JSON.parse(readFileSync(path, "utf8")) as AuditAnchor;
    } catch {
      return {
        seq: Math.max(0, records.length - 1),
        reason: "anchor-mismatch",
        detail: "head anchor file is not valid JSON",
      };
    }
    if (this.signAnchor(anchor.count, anchor.head) !== anchor.sig) {
      return {
        seq: Math.max(0, anchor.count - 1),
        reason: "anchor-mismatch",
        detail: "head anchor signature does not match (forged or corrupted)",
      };
    }
    if (anchor.count !== records.length) {
      const found = opts.fileMissing
        ? `the chain file ${this.file as string} is MISSING (deleted)`
        : `the file has ${records.length}`;
      return {
        seq: Math.max(anchor.count, records.length, 1) - 1,
        reason: "anchor-mismatch",
        detail:
          `head anchor expects ${anchor.count} record(s) but ${found} ` +
          `(${anchor.count > records.length ? "truncated" : "extra/unanchored records"})`,
      };
    }
    const expectedHead = records.length > 0 ? (records[records.length - 1] as AuditRecord).hash : GENESIS_HASH;
    if (anchor.head !== expectedHead) {
      return {
        seq: records.length - 1,
        reason: "anchor-mismatch",
        detail: `head anchor hash does not match the file's actual tail (rewritten without the key?)`,
      };
    }
    return null;
  }

  private persist(record: AuditRecord): void {
    const file = this.file as string;
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const existed = existsSync(file);
    const line = `${JSON.stringify(record)}\n`;

    // Write-then-fsync BEFORE the caller's in-memory head advances (see
    // `append()`): a thrown error here never leaves a committed-in-memory /
    // missing-on-disk gap.
    const fd = openSync(file, "a", 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (!existed) chmodSync(file, 0o600);

    // The anchor always reflects the file's new tail; also fsync'd before we
    // return (and thus before the in-memory head advances).
    this.persistAnchor(record.seq + 1, record.hash);
  }
}

/** Parse an NDJSON audit file into records (skips blank lines). */
export function readNdjsonRecords(file: string): AuditRecord[] {
  const text = readFileSync(file, "utf8");
  const out: AuditRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as AuditRecord);
  }
  return out;
}

/**
 * Verify a hash chain: for each record, its `seq` is its index, its `prevHash`
 * links to the previous record's committed `hash` (GENESIS for the first), and
 * its `hash` recomputes exactly under `key`. Any mutation, reorder, insertion
 * or deletion breaks at least one of these and is reported. `key` is
 * required — without it a chain cannot be authenticated (see `hashchain.ts`).
 */
export function verifyChain(records: readonly AuditRecord[], key: Buffer | string): AuditVerifyResult {
  const tampered: AuditTamper[] = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < records.length; i++) {
    const r = records[i] as AuditRecord;
    if (r.seq !== i) {
      tampered.push({
        seq: r.seq,
        reason: "seq-mismatch",
        detail: `record at index ${i} has seq ${r.seq}`,
      });
    }
    if (i === 0 && r.prevHash !== GENESIS_HASH) {
      tampered.push({
        seq: r.seq,
        reason: "genesis-mismatch",
        detail: `first record prevHash is ${r.prevHash}, expected genesis`,
      });
    }
    if (r.prevHash !== prev) {
      tampered.push({
        seq: r.seq,
        reason: "prev-hash-mismatch",
        detail: `prevHash ${r.prevHash} does not link to prior hash ${prev}`,
      });
    }
    const { hash, ...hashable } = r;
    const expected = computeHash(hashable, key);
    if (expected !== hash) {
      tampered.push({
        seq: r.seq,
        reason: "hash-mismatch",
        detail: `record content does not match its hash (recomputed ${expected})`,
      });
    }
    prev = r.hash;
  }
  return { ok: tampered.length === 0, count: records.length, tampered };
}

export { REDACTED };
