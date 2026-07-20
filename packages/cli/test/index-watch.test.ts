/**
 * Watch-mode incremental indexing (system-spec §23, Wave 12): `nexus index --watch`
 * must do one initial full index, then — on a debounced change — incrementally
 * re-embed ONLY the documents whose content changed and persist the store. Driven
 * deterministically through the returned handle's notify/flush (no real fs-event
 * timing), fully offline via the default hashing embedder + temp dirs.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NexusConfig } from "@nexuscode/config";
import { startIndexWatch } from "../src/commands.js";

interface CapturedIo {
  out: (s: string) => void;
  err: (s: string) => void;
  stdout: string;
  stderr: string;
}
function makeIo(): CapturedIo {
  const io: CapturedIo = {
    stdout: "",
    stderr: "",
    out: (s) => {
      io.stdout += s;
    },
    err: (s) => {
      io.stderr += s;
    },
  };
  return io;
}

describe("startIndexWatch (nexus index --watch)", () => {
  it("initial-indexes then incrementally reindexes only changed files", async () => {
    const root = mkdtempSync(join(tmpdir(), "nx-watch-src-"));
    const store = mkdtempSync(join(tmpdir(), "nx-watch-idx-"));
    writeFileSync(join(root, "a.md"), "alpha content about provider routing", "utf8");
    const config = NexusConfig.parse({ rag: { storeFile: store } });

    const io = makeIo();
    const { handle, index, initial } = await startIndexWatch(root, config, io);
    try {
      expect(initial).toBe(1);
      const afterInitial = index.size;
      expect(afterInitial).toBeGreaterThan(0);

      // Add a NEW file → one changed doc embedded, the existing one skipped by hash.
      writeFileSync(join(root, "b.md"), "beta content about response caching", "utf8");
      handle.notify("b.md");
      await handle.flush();
      expect(index.size).toBeGreaterThan(afterInitial);
      expect(io.stderr).toContain("[watch] reindexed");
      expect(io.stderr).toContain("1 changed");

      // A flush with NO content change re-embeds nothing (incremental hash-diff).
      handle.notify("a.md");
      await handle.flush();
      expect(io.stderr).toContain("0 changed");
    } finally {
      handle.close();
    }
  });

  it("persists the index to the configured store so `search` can read it back", async () => {
    const root = mkdtempSync(join(tmpdir(), "nx-watch-src2-"));
    const store = mkdtempSync(join(tmpdir(), "nx-watch-idx2-"));
    writeFileSync(join(root, "notes.md"), "the quick brown fox jumps", "utf8");
    const config = NexusConfig.parse({ rag: { storeFile: store } });

    const io = makeIo();
    const { handle } = await startIndexWatch(root, config, io);
    handle.close();

    // A fresh index pointed at the same store loads the persisted chunks.
    const { openRagIndex } = await import("../src/power.js");
    const reopened = openRagIndex(config, { cached: false, load: true });
    expect(reopened.size).toBeGreaterThan(0);
  });
});
