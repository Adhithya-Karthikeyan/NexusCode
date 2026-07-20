/**
 * Incremental + watch-mode RAG indexing tests (system-spec §23). All offline and
 * deterministic (HashingEmbedder + a spy embedder; a manually-triggered watcher —
 * no real filesystem-event timing, no long sleeps).
 */
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  RagIndex,
  HashingEmbedder,
  BackgroundIndexer,
  watchAndReindex,
  DOC_HASH_META,
  type Embedder,
  type RagDocument,
} from "../src/index.js";
import { resolveChangedPath } from "../src/watch.js";

const tmps: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rag-watch-"));
  tmps.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmps.length) {
    const d = tmps.pop()!;
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

/** A HashingEmbedder wrapper that counts how many TEXTS were embedded. */
function countingEmbedder(dims = 128): { embedder: Embedder; embeddedTexts: string[] } {
  const inner = new HashingEmbedder({ dims });
  const embeddedTexts: string[] = [];
  const embedder: Embedder = {
    id: inner.id,
    dims: inner.dims,
    embed: async (texts) => {
      embeddedTexts.push(...texts);
      return inner.embed(texts);
    },
  };
  return { embedder, embeddedTexts };
}

describe("RagIndex.incrementalIndex — re-embed only changed documents", () => {
  it("skips unchanged documents (no embedder call) and re-embeds a changed one", async () => {
    const { embedder, embeddedTexts } = countingEmbedder();
    const index = new RagIndex({ embedder });

    const docs: RagDocument[] = [
      { id: "a", text: "alpha content one" },
      { id: "b", text: "bravo content two" },
    ];

    // First pass embeds both.
    const first = await index.incrementalIndex(docs);
    expect(first.indexed.sort()).toEqual(["a", "b"]);
    expect(first.skipped).toEqual([]);
    const afterFirst = embeddedTexts.length;
    expect(afterFirst).toBeGreaterThan(0);

    // Second pass: identical content ⇒ NOTHING is embedded.
    const second = await index.incrementalIndex(docs);
    expect(second.indexed).toEqual([]);
    expect(second.skipped.sort()).toEqual(["a", "b"]);
    expect(embeddedTexts.length).toBe(afterFirst); // embed count unchanged

    // Third pass: change only "b" ⇒ only "b" is re-embedded, "a" is skipped.
    const changed: RagDocument[] = [
      { id: "a", text: "alpha content one" },
      { id: "b", text: "bravo content two — EDITED" },
    ];
    const before = embeddedTexts.length;
    const third = await index.incrementalIndex(changed);
    expect(third.indexed).toEqual(["b"]);
    expect(third.skipped).toEqual(["a"]);
    // Exactly the edited document's chunks were embedded; none of "a"'s.
    const newlyEmbedded = embeddedTexts.slice(before);
    expect(newlyEmbedded.length).toBeGreaterThan(0);
    expect(newlyEmbedded.some((t) => t.includes("EDITED"))).toBe(true);
    expect(newlyEmbedded.some((t) => t.includes("alpha"))).toBe(false);
  });

  it("prunes documents absent from the input when prune is set", async () => {
    const { embedder } = countingEmbedder();
    const index = new RagIndex({ embedder });
    await index.incrementalIndex([
      { id: "keep", text: "still here" },
      { id: "drop", text: "will be removed" },
    ]);
    const res = await index.incrementalIndex([{ id: "keep", text: "still here" }], { prune: true });
    expect(res.removed).toEqual(["drop"]);
    expect(res.skipped).toEqual(["keep"]);
    const results = await index.query("removed", { topK: 10 });
    expect(results.some((r) => r.chunk.docId === "drop")).toBe(false);
  });

  it("stamps a content hash into chunk meta for future comparisons", async () => {
    const { embedder } = countingEmbedder();
    const index = new RagIndex({ embedder });
    await index.incrementalIndex([{ id: "a", text: "hashed content" }]);
    const chunk = index.vectorStore.chunks().find((c) => c.docId === "a");
    expect(typeof chunk?.meta?.[DOC_HASH_META]).toBe("string");
  });
});

describe("BackgroundIndexer — non-blocking indexing with progress", () => {
  it("returns immediately and reports progress until done", async () => {
    const { embedder } = countingEmbedder();
    const index = new RagIndex({ embedder });
    const runner = new BackgroundIndexer();

    const handle = runner.start(index, [
      { id: "a", text: "aaa" },
      { id: "b", text: "bbb" },
    ]);

    // The call returned without blocking on the embedding work.
    expect(handle.progress.phase).toBe("running");
    expect(handle.progress.endedAt).toBeUndefined();

    const result = await handle.whenDone();
    expect(result.indexed.sort()).toEqual(["a", "b"]);
    expect(handle.progress.phase).toBe("done");
    expect(handle.progress.done).toBe(2);
    expect(handle.progress.total).toBe(2);
    expect(index.size).toBeGreaterThan(0);
  });

  it("skips unchanged docs on a background re-run", async () => {
    const { embedder } = countingEmbedder();
    const index = new RagIndex({ embedder });
    const runner = new BackgroundIndexer();
    await runner.start(index, [{ id: "a", text: "same" }]).whenDone();
    const second = await runner.start(index, [{ id: "a", text: "same" }]).whenDone();
    expect(second.indexed).toEqual([]);
    expect(second.skipped).toEqual(["a"]);
  });

  it("a poll-only caller (never calling whenDone()) is never crashed by an unhandled rejection", async () => {
    const boomEmbedder: Embedder = {
      id: "boom",
      dims: 4,
      embed: async () => {
        throw new Error("embed boom");
      },
    };
    const index = new RagIndex({ embedder: boomEmbedder });
    const runner = new BackgroundIndexer();

    const seen: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      seen.push(err);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // Deliberately only reads `.progress` — NEVER calls `handle.whenDone()`.
      const handle = runner.start(index, [{ id: "a", text: "will fail to embed" }]);
      // Let the background run actually settle (it rejects internally).
      await new Promise((r) => setTimeout(r, 20));
      expect(handle.progress.phase).toBe("error");
      expect(handle.progress.error).toContain("embed boom");
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});

describe("watchAndReindex — debounced incremental reindex on change", () => {
  it("picks up a manually-triggered change and re-embeds only the changed file", async () => {
    const { embedder, embeddedTexts } = countingEmbedder();
    const index = new RagIndex({ embedder });

    // A tiny in-memory "filesystem" the loadDocs closure reads from.
    const files = new Map<string, string>([
      ["a.txt", "alpha original"],
      ["b.txt", "bravo original"],
    ]);

    const reindexes: string[][] = [];
    const handle = watchAndReindex("/virtual", {
      index,
      delayMs: 5,
      loadDocs: (paths) =>
        paths
          .filter((p) => files.has(p))
          .map((p) => ({ id: p, text: files.get(p)!, source: p })),
      onReindex: (r) => reindexes.push(r.indexed),
    });

    // Seed the index by triggering both files once.
    handle.notify("a.txt");
    handle.notify("b.txt");
    await handle.flush();
    expect(reindexes.at(-1)?.sort()).toEqual(["a.txt", "b.txt"]);
    const afterSeed = embeddedTexts.length;

    // Edit ONE file, then manually trigger the watcher for it.
    files.set("b.txt", "bravo EDITED body");
    handle.notify("b.txt");
    await handle.flush();

    // The watcher reindexed only b.txt; a.txt was untouched.
    expect(reindexes.at(-1)).toEqual(["b.txt"]);
    const newly = embeddedTexts.slice(afterSeed);
    expect(newly.some((t) => t.includes("EDITED"))).toBe(true);
    expect(newly.some((t) => t.includes("alpha"))).toBe(false);

    handle.close();
  });

  it("uses an injectable watch source and coalesces a burst into one reindex", async () => {
    const { embedder } = countingEmbedder();
    const index = new RagIndex({ embedder });
    let emit!: (path: string) => void;
    const reindexes: string[][] = [];

    const handle = watchAndReindex("/virtual", {
      index,
      delayMs: 5,
      watchSource: (_dir, onChange) => {
        emit = onChange;
        return { close: () => {} };
      },
      loadDocs: (paths) => paths.map((p) => ({ id: p, text: `content of ${p}` })),
      onReindex: (r) => reindexes.push(r.indexed),
    });

    // A burst of raw events for one logical edit.
    emit("x.txt");
    emit("x.txt");
    await handle.flush();
    expect(reindexes).toEqual([["x.txt"]]);
    handle.close();
  });
});

describe("resolveChangedPath — symlink escape guard (watch mode)", () => {
  it("passes through a change inside the watched root", async () => {
    const dir = await mkTmp();
    await fs.writeFile(path.join(dir, "inside.txt"), "hello");
    expect(resolveChangedPath(dir, "inside.txt")).toBe("inside.txt");
  });

  it("skips a symlink whose real path escapes the watched root", async () => {
    const outside = await mkTmp();
    await fs.writeFile(path.join(outside, "secret.txt"), "outside content");
    const dir = await mkTmp();
    await fs.symlink(path.join(outside, "secret.txt"), path.join(dir, "escape.txt"));

    expect(resolveChangedPath(dir, "escape.txt")).toBeUndefined();
  });

  it("passes through a vanished path (nothing left to read/embed)", async () => {
    const dir = await mkTmp();
    expect(resolveChangedPath(dir, "never-existed.txt")).toBe("never-existed.txt");
  });
});
