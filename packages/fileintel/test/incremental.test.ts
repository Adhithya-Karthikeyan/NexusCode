/**
 * Incremental + watch-mode repo indexing tests (system-spec §23). Offline and
 * deterministic: a real temp dir for the incremental parse-count check, and a
 * manually-triggered injectable watcher (no fs.watch timing, no long sleeps).
 */
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promises as fs } from "node:fs";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { heuristicParser } from "../src/heuristic.js";
import type { Parser } from "../src/parser.js";
import { IncrementalRepoIndexer } from "../src/incremental.js";
import { watchProject, resolveChangedPath } from "../src/watch.js";
import { buildIndex } from "../src/index-build.js";

/** Wrap the shipped parser to count how many files it parses. */
function countingParser(): { parser: Parser; parsedSymbols: string[] } {
  const parsedSymbols: string[] = [];
  const parser: Parser = {
    symbols: (code, lang) => {
      // Tag each parse with the first identifier so the test can see WHICH files parsed.
      parsedSymbols.push(code.slice(0, 40));
      return heuristicParser.symbols(code, lang);
    },
    imports: (code, lang) => heuristicParser.imports(code, lang),
  };
  return { parser, parsedSymbols };
}

const tmps: string[] = [];
async function mkTmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fileintel-inc-"));
  tmps.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmps.length) {
    const d = tmps.pop()!;
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
  vi.useRealTimers();
});

describe("IncrementalRepoIndexer — re-parse only changed files", () => {
  it("parses everything the first pass, then only the changed file on the next", async () => {
    const dir = await mkTmp();
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(dir, "b.ts"), "export function b() { return a; }\n");

    const { parser, parsedSymbols } = countingParser();
    const indexer = new IncrementalRepoIndexer({ parser });

    // First pass parses both files.
    const first = await indexer.update(dir);
    expect(first.changed.sort()).toEqual(["a.ts", "b.ts"]);
    expect(parsedSymbols.length).toBe(2);
    expect(first.index.files.size).toBe(2);

    // Re-run with no changes: NOTHING is parsed; everything is reused.
    parsedSymbols.length = 0;
    const second = await indexer.update(dir);
    expect(second.changed).toEqual([]);
    expect(second.reused.sort()).toEqual(["a.ts", "b.ts"]);
    expect(parsedSymbols.length).toBe(0);
    // The derived index is still complete despite parsing nothing.
    expect(second.index.files.size).toBe(2);

    // Edit ONE file (bump mtime deterministically) → only that file re-parses.
    parsedSymbols.length = 0;
    const future = new Date(Date.now() + 5000);
    await fs.writeFile(path.join(dir, "b.ts"), "export function b() { return a + 1; }\n");
    await fs.utimes(path.join(dir, "b.ts"), future, future);

    const third = await indexer.update(dir);
    expect(third.changed).toEqual(["b.ts"]);
    expect(third.reused).toEqual(["a.ts"]);
    expect(parsedSymbols.length).toBe(1);
    expect(parsedSymbols[0]).toContain("a + 1");
  });

  it("drops files that were removed from the tree", async () => {
    const dir = await mkTmp();
    await fs.writeFile(path.join(dir, "keep.ts"), "export const k = 1;\n");
    await fs.writeFile(path.join(dir, "gone.ts"), "export const g = 2;\n");

    const indexer = new IncrementalRepoIndexer();
    const first = await indexer.update(dir);
    expect(first.index.files.has("gone.ts")).toBe(true);

    await fs.rm(path.join(dir, "gone.ts"));
    const second = await indexer.update(dir);
    expect(second.removed).toEqual(["gone.ts"]);
    expect(second.index.files.has("gone.ts")).toBe(false);
    expect(second.index.files.has("keep.ts")).toBe(true);
  });

  it("keeps the dependency graph correct across an incremental update", async () => {
    const dir = await mkTmp();
    await fs.writeFile(path.join(dir, "util.ts"), "export const helper = 1;\n");
    await fs.writeFile(path.join(dir, "main.ts"), "import { helper } from './util.js';\n");

    const indexer = new IncrementalRepoIndexer();
    const res = await indexer.update(dir);
    expect([...(res.index.dependencies.get("main.ts") ?? [])]).toContain("util.ts");
  });

  it("matches a full rebuild's deterministic key order when a file is added on a later update", async () => {
    const dir = await mkTmp();
    // "b.ts" sorts AFTER a file we add later ("a.ts") — the case that
    // previously diverged: a brand-new key appended via Map.set() lands at the
    // END of insertion order, not in its sorted position.
    await fs.writeFile(path.join(dir, "b.ts"), "export function b() { return 1; }\n");

    const indexer = new IncrementalRepoIndexer();
    await indexer.update(dir); // seed with only b.ts

    await fs.writeFile(path.join(dir, "a.ts"), "export function a() { return b(); }\n");
    const incremental = await indexer.update(dir);

    const full = await buildIndex(dir);

    expect([...incremental.index.files.keys()]).toEqual([...full.files.keys()]);
    expect([...incremental.index.symbols.keys()]).toEqual([...full.symbols.keys()]);
    expect([...incremental.index.xrefs.keys()]).toEqual([...full.xrefs.keys()]);
  });
});

describe("resolveChangedPath — symlink escape guard (watch mode)", () => {
  it("passes through a change inside the watched root", async () => {
    const dir = await mkTmp();
    await fs.writeFile(path.join(dir, "inside.ts"), "export const x = 1;\n");
    expect(resolveChangedPath(dir, "inside.ts")).toBe("inside.ts");
  });

  it("skips a symlink whose real path escapes the watched root", async () => {
    const outside = await mkTmp();
    await fs.writeFile(path.join(outside, "secret.ts"), "export const secret = 1;\n");
    const dir = await mkTmp();
    await fs.symlink(path.join(outside, "secret.ts"), path.join(dir, "escape.ts"));

    expect(resolveChangedPath(dir, "escape.ts")).toBeUndefined();
  });

  it("passes through a vanished path (nothing left to read)", async () => {
    const dir = await mkTmp();
    expect(resolveChangedPath(dir, "never-existed.ts")).toBe("never-existed.ts");
  });
});

describe("watchProject — debounced reindex on a change", () => {
  it("picks up a manually-triggered change and reindexes once", async () => {
    const dir = await mkTmp();
    await fs.writeFile(path.join(dir, "a.ts"), "export const a = 1;\n");

    const indexer = new IncrementalRepoIndexer();
    await indexer.update(dir); // seed

    const reindexed: string[][] = [];
    const handle = watchProject(dir, {
      delayMs: 5,
      onReindex: async (paths) => {
        reindexed.push(paths);
        await indexer.update(dir);
      },
    });

    // Manual trigger — no reliance on fs.watch delivery.
    handle.notify("a.ts");
    handle.notify("a.ts"); // burst collapses
    await handle.flush();

    expect(reindexed).toEqual([["a.ts"]]);
    handle.close();
  });

  it("drives reindex through an injectable watch source", async () => {
    const dir = await mkTmp();
    let emit!: (p: string) => void;
    const seen: string[][] = [];
    const handle = watchProject(dir, {
      delayMs: 5,
      watchSource: (_d, onChange) => {
        emit = onChange;
        return { close: () => {} };
      },
      onReindex: (paths) => void seen.push(paths),
    });

    emit("x.ts");
    emit("y.ts");
    await handle.flush();
    expect(seen).toEqual([["x.ts", "y.ts"]]);
    handle.close();
  });
});
