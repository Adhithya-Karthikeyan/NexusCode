import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlobStore } from "../src/blobs.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "zlcts-blobs-"));
}

describe("BlobStore", () => {
  it("put/get round-trips a string", () => {
    const dir = tmp();
    try {
      const bs = createBlobStore(dir);
      const ref = bs.put("hello world");
      expect(ref.startsWith("blob_")).toBe(true);
      const bytes = bs.get(ref);
      expect(bytes).not.toBeNull();
      expect(Buffer.from(bytes!).toString("utf8")).toBe("hello world");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("round-trips raw bytes", () => {
    const dir = tmp();
    try {
      const bs = createBlobStore(dir);
      const data = new Uint8Array([0, 1, 2, 255, 128]);
      const ref = bs.put(data);
      const got = bs.get(ref);
      expect(Array.from(got!)).toEqual([0, 1, 2, 255, 128]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dedups: same content → same ref, file written once", () => {
    const dir = tmp();
    try {
      const bs = createBlobStore(dir);
      const ref1 = bs.put("same");
      const ref2 = bs.put("same");
      expect(ref1).toBe(ref2);
      const files = readdirSync(join(dir, "blobs")).filter((f) => !f.endsWith(".tmp"));
      const matching = files.filter((f) => f === ref1);
      expect(matching.length).toBe(1);
      // file exists exactly once
      expect(existsSync(join(dir, "blobs", ref1))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("get returns null for missing ref", () => {
    const dir = tmp();
    try {
      const bs = createBlobStore(dir);
      expect(bs.get("blob_deadbeefdeadbeef")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});