/**
 * Incremental repository indexing (system-spec §23: incremental updates). The
 * one-shot {@link buildIndex} re-reads and re-parses every file on every call.
 * For a live session that is wasteful: after a single edit only one file changed.
 *
 * {@link IncrementalRepoIndexer} keeps a manifest of each file's `mtime`+size and
 * a cache of its parse result (symbols, imports) and identifier tokens. On
 * {@link IncrementalRepoIndexer.update} it re-walks the tree, re-reads and
 * re-parses ONLY the files whose `mtime`/size changed (plus new files), reuses the
 * cached parse for everything unchanged, drops deleted files, and then recomputes
 * the derived graphs (symbol table, dependency edges, cross-references) from the
 * merged in-memory caches — no unchanged file is ever read from disk again.
 *
 * Deterministic and offline; the derived {@link RepoIndex} is byte-for-byte the
 * same as a full {@link buildIndex} over the same tree.
 */

import { promises as fs } from "node:fs";
import { detectLanguage, isParseable, type Lang, PARSEABLE_LANGS } from "./language.js";
import { heuristicParser } from "./heuristic.js";
import type { Parser } from "./parser.js";
import { resolveImport, type FileInfo, type RepoIndex, type SymbolDef } from "./index-build.js";
import { walkProject, type WalkOptions } from "./walk.js";

const DEFAULT_LANGSET: ReadonlySet<Lang> = new Set(PARSEABLE_LANGS);

export interface IncrementalIndexOptions extends WalkOptions {
  /** Parser to use (default the shipped {@link heuristicParser}). */
  parser?: Parser;
  /** Per-file byte cap when READING content (default 512_000). */
  maxReadBytes?: number;
}

/** What an {@link IncrementalRepoIndexer.update} pass did. */
export interface IncrementalUpdate {
  /** The freshly-assembled repository index. */
  index: RepoIndex;
  /** Files re-read + re-parsed because they were new or changed. */
  changed: string[];
  /** Files removed from the index because they vanished from the tree. */
  removed: string[];
  /** Files reused from cache without any disk read or parse. */
  reused: string[];
}

/** Split source into referenceable identifier tokens (for cross-references). */
function identifiers(code: string): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.add(m[0]);
  return out;
}

/** Stateful incremental indexer. Construct once and call {@link update} repeatedly. */
export class IncrementalRepoIndexer {
  private readonly parser: Parser;
  private readonly maxReadBytes: number;

  /** path → the last-seen stat signature (mtime + size). */
  private readonly manifest = new Map<string, { mtimeMs: number; bytes: number }>();
  /** path → cached per-file parse result. */
  private readonly fileInfos = new Map<string, FileInfo>();
  /** path → cached identifier token set (for xref). */
  private readonly identifiers = new Map<string, Set<string>>();

  constructor(opts: { parser?: Parser; maxReadBytes?: number } = {}) {
    this.parser = opts.parser ?? heuristicParser;
    this.maxReadBytes = opts.maxReadBytes ?? 512_000;
  }

  /** Paths currently held in the index. */
  get trackedFiles(): string[] {
    return [...this.fileInfos.keys()];
  }

  /**
   * Re-walk `root` and re-index only changed/new files, reusing cache for the
   * rest. Returns the fresh {@link RepoIndex} plus which files were touched.
   */
  async update(root: string, opts: IncrementalIndexOptions = {}): Promise<IncrementalUpdate> {
    const langs = opts.langs ?? DEFAULT_LANGSET;
    const walked = await walkProject(root, { ...opts, langs });

    const changed: string[] = [];
    const reused: string[] = [];
    const present = new Set<string>();

    for (const entry of walked) {
      const lang = detectLanguage(entry.path);
      if (!isParseable(lang)) continue;
      present.add(entry.path);

      const prev = this.manifest.get(entry.path);
      const unchanged =
        prev !== undefined && prev.mtimeMs === entry.mtimeMs && prev.bytes === entry.bytes;
      if (unchanged && this.fileInfos.has(entry.path)) {
        reused.push(entry.path);
        continue;
      }

      // New or changed → read + parse this file (and only this file).
      let code: string;
      try {
        if (entry.bytes > this.maxReadBytes) {
          // Too large to parse: drop any stale cache entry and skip.
          this.fileInfos.delete(entry.path);
          this.identifiers.delete(entry.path);
          this.manifest.set(entry.path, { mtimeMs: entry.mtimeMs, bytes: entry.bytes });
          continue;
        }
        code = await fs.readFile(entry.absPath, "utf8");
      } catch {
        continue;
      }
      const syms = this.parser.symbols(code, lang);
      const imports = this.parser.imports(code, lang);
      this.fileInfos.set(entry.path, {
        path: entry.path,
        lang,
        bytes: entry.bytes,
        symbols: syms,
        imports,
        deps: [],
      });
      this.identifiers.set(entry.path, identifiers(code));
      this.manifest.set(entry.path, { mtimeMs: entry.mtimeMs, bytes: entry.bytes });
      changed.push(entry.path);
    }

    // Drop files that disappeared from the tree.
    const removed: string[] = [];
    for (const path of [...this.manifest.keys()]) {
      if (!present.has(path)) {
        this.manifest.delete(path);
        this.fileInfos.delete(path);
        this.identifiers.delete(path);
        removed.push(path);
      }
    }

    return {
      index: this.assemble(root),
      changed: changed.sort(),
      removed: removed.sort(),
      reused: reused.sort(),
    };
  }

  /**
   * Rebuild the derived graphs from the (cached + fresh) per-file results.
   * Iterates files in SORTED path order (not `fileInfos`' Map insertion
   * order): a file added on a later {@link update} is `.set()` for the first
   * time then, which appends it at the END of Map iteration order — diverging
   * from a full rebuild, whose `files` walk is already path-sorted (§`walkProject`).
   * Sorting here makes every derived Map's key order match a full rebuild's
   * byte-for-byte, regardless of the order updates happened to arrive in.
   */
  private assemble(root: string): RepoIndex {
    const sortedPaths = [...this.fileInfos.keys()].sort();
    const files = new Map<string, FileInfo>();
    const symbols = new Map<string, SymbolDef[]>();
    for (const path of sortedPaths) {
      const info = this.fileInfos.get(path)!;
      files.set(info.path, info);
      for (const s of info.symbols) {
        const def: SymbolDef = { ...s, file: info.path };
        const list = symbols.get(s.name);
        if (list) list.push(def);
        else symbols.set(s.name, [def]);
      }
    }

    const fileSet = new Set(files.keys());
    const dependencies = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();
    for (const info of files.values()) {
      const deps = new Set<string>();
      for (const spec of info.imports) {
        const target = resolveImport(spec, info.path, fileSet);
        if (target && target !== info.path && files.has(target)) deps.add(target);
      }
      info.deps = [...deps].sort();
      dependencies.set(info.path, deps);
      for (const target of deps) {
        let back = dependents.get(target);
        if (!back) {
          back = new Set<string>();
          dependents.set(target, back);
        }
        back.add(info.path);
      }
    }

    const xrefs = new Map<string, Set<string>>();
    for (const file of sortedPaths) {
      const toks = this.identifiers.get(file);
      if (!toks) continue;
      for (const name of toks) {
        const defs = symbols.get(name);
        if (!defs) continue;
        if (defs.some((d) => d.file === file)) continue;
        let set = xrefs.get(name);
        if (!set) {
          set = new Set<string>();
          xrefs.set(name, set);
        }
        set.add(file);
      }
    }

    return { root, files, symbols, dependencies, dependents, xrefs };
  }
}
