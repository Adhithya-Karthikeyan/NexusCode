/**
 * Hash-chain primitives for the tamper-evident audit log. Each record commits
 * `hash = HMAC-SHA256(key, prevHash + canonical(record-without-hash))`. Keying
 * the chain with a secret (resolved via the SecretStore — see `./key.js` —
 * and never co-located with the log file) is what makes it UNFORGEABLE: an
 * unkeyed `SHA256(prevHash + record)` chain is pure public data, so anyone
 * with file-write access can recompute the WHOLE chain from genesis and
 * `verify()` still passes. HMAC closes that hole — without the key, no
 * attacker can produce a hash that recomputes correctly, no matter how much of
 * the file they rewrite. Canonicalization is deterministic (stable key order,
 * no whitespace) so the hash is reproducible across processes and re-reads of
 * the NDJSON file.
 */

import { createHmac } from "node:crypto";
import type { AuditRecord } from "./types.js";

/** prevHash of the very first record in a chain. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * The current record-shape / chain-algorithm version, carried as `v` on every
 * record (and included in what gets hashed). Bump this if the committed shape
 * or hashing algorithm ever changes again.
 */
export const AUDIT_RECORD_VERSION = 2;

/** The record shape whose hash we compute — everything except `hash` itself. */
export type HashableRecord = Omit<AuditRecord, "hash">;

/**
 * Deterministic JSON: object keys sorted lexicographically at every level so two
 * structurally-equal records always serialize identically. Arrays keep order.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    if (v === undefined) continue; // drop undefined so optional fields don't shift the hash
    out[key] = sortDeep(v);
  }
  return out;
}

/**
 * Compute the commit hash for a record, HMAC-keyed with the log's secret.
 * `prevHash` is also carried inside the record, but we prepend it explicitly so
 * the definition literally reads `HMAC(key, prevHash + record)` as specified.
 * `key` is REQUIRED — see the module doc for why an unkeyed hash is exactly
 * the forgeability hole this chain closes.
 */
export function computeHash(rec: HashableRecord, key: Buffer | string): string {
  return createHmac("sha256", key).update(rec.prevHash).update(canonicalize(rec)).digest("hex");
}
