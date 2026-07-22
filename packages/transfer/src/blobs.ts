/**
 * Content-addressed blob store — backs WAL payloads, verbatim chunks, and
 * tool-progress partial output. Deduped by sha256, atomic via temp+rename.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A minimal content-addressed store. */
export interface BlobStore {
  /** Store data, return `blob_<sha256[:16]>`. No-op if the blob already exists. */
  put(data: Uint8Array | string): string;
  /** Read a blob by ref, or null if missing. */
  get(ref: string): Uint8Array | null;
}

/** Create a BlobStore rooted at `<dir>/blobs/`. */
export function createBlobStore(dir: string): BlobStore {
  const blobsDir = join(dir, "blobs");
  mkdirSync(blobsDir, { recursive: true });

  return {
    put(data: Uint8Array | string): string {
      const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
      const ref = `blob_${hash}`;
      const file = join(blobsDir, ref);
      if (!existsSync(file)) {
        const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
        writeFileSync(tmp, bytes);
        renameSync(tmp, file);
      }
      return ref;
    },
    get(ref: string): Uint8Array | null {
      const file = join(blobsDir, ref);
      if (!existsSync(file)) return null;
      const buf = readFileSync(file);
      // Return a fresh Uint8Array view (not the shared Buffer internal).
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },
  };
}

/** Resolve a blob ref to its on-disk path (test helper). */
export function blobPath(dir: string, ref: string): string {
  return join(dirname(join(dir, "blobs")), "blobs", ref);
}