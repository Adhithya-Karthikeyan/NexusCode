/**
 * Resolves (and generates, on first use) the audit chain's HMAC-SHA256 secret
 * through the `SecretStore` (`@nexuscode/config`: env → OS keychain →
 * encrypted vault file, 0600). Deliberately NOT co-located with the audit log
 * file or its directory: an attacker who gains write access to the log
 * (enough to rewrite/truncate the NDJSON) does not thereby gain the key, so
 * they cannot produce a hash — or a signed head anchor, see `log.ts` — that
 * will verify. See `hashchain.ts` for why an unkeyed chain is forgeable.
 */

import { randomBytes } from "node:crypto";
import type { SecretStore } from "@nexuscode/config";

/** Default SecretStore ref the audit chain's HMAC key is stored under. */
export const DEFAULT_AUDIT_KEY_REF = "nexus.audit.hmac_key";

/** Build a SecretStore ref scoped to a specific audit file (when one governs it). */
export function auditKeyRef(file?: string): string {
  return file ? `${DEFAULT_AUDIT_KEY_REF}:${file}` : DEFAULT_AUDIT_KEY_REF;
}

/**
 * Resolve this log's HMAC key from `secrets`, generating + persisting a fresh
 * 256-bit key (hex-encoded) through the store on first use. The same `ref`
 * always resolves to the same key, so a chain built by one process verifies
 * in the next — the store, not the log file, is the durable source of truth
 * for the secret.
 */
export async function resolveAuditKey(
  secrets: SecretStore,
  ref: string = DEFAULT_AUDIT_KEY_REF,
): Promise<Buffer> {
  const existing = await secrets.get(ref);
  if (existing) return Buffer.from(existing, "hex");
  const fresh = randomBytes(32);
  await secrets.set(ref, fresh.toString("hex"));
  return fresh;
}
