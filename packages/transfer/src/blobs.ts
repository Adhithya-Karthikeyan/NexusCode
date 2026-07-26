/**
 * Content-addressed blob store — backs WAL payloads, verbatim chunks, and
 * tool-progress partial output. Deduped by sha256, atomic via temp+rename.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const ENVELOPE_MAGIC = Buffer.from("NXB1", "ascii");

/** A minimal content-addressed store. */
export interface BlobStore {
  /** Whether newly-written blobs are AES-256-GCM encrypted at rest. */
  readonly encrypted: boolean;
  /** Store data, return `blob_<sha256[:16]>`. No-op if the blob already exists. */
  put(data: Uint8Array | string): string;
  /** Read a blob by ref, or null if missing. */
  get(ref: string): Uint8Array | null;
}

export interface BlobStoreOptions {
  /** Exactly 32 bytes. When present, blobs are encrypted with AES-256-GCM. */
  encryptionKey?: Uint8Array;
}

function isEncryptedEnvelope(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 32 && Buffer.from(bytes).subarray(0, 4).equals(ENVELOPE_MAGIC);
}

function encrypt(bytes: Uint8Array, key: Uint8Array): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([ENVELOPE_MAGIC, nonce, tag, ciphertext]);
}

function decrypt(bytes: Uint8Array, key: Uint8Array): Buffer | null {
  if (!isEncryptedEnvelope(bytes)) return Buffer.from(bytes);
  try {
    const buf = Buffer.from(bytes);
    const nonce = buf.subarray(4, 16);
    const tag = buf.subarray(16, 32);
    const ciphertext = buf.subarray(32);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }
}

/** Create a BlobStore rooted at `<dir>/blobs/`. */
export function createBlobStore(dir: string, opts: BlobStoreOptions = {}): BlobStore {
  const key = opts.encryptionKey;
  if (key && key.byteLength !== 32) {
    throw new Error("blob encryption key must be exactly 32 bytes");
  }
  const blobsDir = join(dir, "blobs");
  mkdirSync(blobsDir, { recursive: true, mode: 0o700 });

  return {
    encrypted: key !== undefined,
    put(data: Uint8Array | string): string {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      const ref = `blob_${hash}`;
      const file = join(blobsDir, ref);
      const existing = existsSync(file) ? readFileSync(file) : null;
      // When encryption is enabled, transparently upgrade a legacy plaintext
      // blob rather than leaving sensitive data clear merely because the
      // content-addressed filename already existed.
      if (!existing || (key && !isEncryptedEnvelope(existing))) {
        const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
        writeFileSync(tmp, key ? encrypt(bytes, key) : bytes, { mode: 0o600 });
        renameSync(tmp, file);
      }
      try {
        chmodSync(file, 0o600);
      } catch {
        /* best-effort on filesystems without POSIX modes */
      }
      return ref;
    },
    get(ref: string): Uint8Array | null {
      const file = join(blobsDir, ref);
      if (!existsSync(file)) return null;
      const buf = readFileSync(file);
      if (isEncryptedEnvelope(buf)) {
        if (!key) return null;
        const plain = decrypt(buf, key);
        if (!plain) return null;
        return new Uint8Array(plain.buffer, plain.byteOffset, plain.byteLength);
      }
      // Return a fresh Uint8Array view (not the shared Buffer internal).
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
  };
}

/** Resolve a blob ref to its on-disk path (test helper). */
export function blobPath(dir: string, ref: string): string {
  return join(dirname(join(dir, "blobs")), "blobs", ref);
}
