/**
 * Repository index (system-spec §11): symbol index (name → definitions across
 * files), dependency graph (file → imported files), and cross-references
 * (symbol → files that reference it). Built by walking the tree, reading each
 * parseable source file (under the size guard), and running the {@link Parser}
 * seam over it. Everything is deterministic and offline.
 */

import { promises as fs } from "node:fs";
import { detectLanguage, isParseable, type Lang, PARSEABLE_LANGS } from "./language.js";
import { heuristicParser } from "./heuristic.js";
import type { CodeSymbol, Parser } from "./parser.js";
import { walkProject, type WalkOptions } from "./walk.js";

/** A symbol paired with the file it was defined in. */
export interface SymbolDef extends CodeSymbol {
  /** Posix path (relative to root) of the defining file. */
  file: string;
}

/** Per-file analysis result. */
export interface FileInfo {
  path: string;
  lang: Lang;
  bytes: number;
  symbols: CodeSymbol[];
  /** Raw import specifiers as written in source. */
  imports: string[];
  /** Import specifiers resolved to in-repo files (dependency edge targets). */
  deps: string[];
}

export interface BuildIndexOptions extends WalkOptions {
  /** Parser to use (default: the shipped {@link heuristicParser}). */
  parser?: Parser;
  /** Per-file byte cap when READING content (separate from the walk guard). */
  maxReadBytes?: number;
}

/** The assembled repository index. */
export interface RepoIndex {
  root: string;
  /** Every analysed file, keyed by posix-relative path. */
  files: Map<string, FileInfo>;
  /** name → all definitions of that name across the repo. */
  symbols: Map<string, SymbolDef[]>;
  /** file → set of in-repo files it depends on (import edges). */
  dependencies: Map<string, Set<string>>;
  /** file → set of in-repo files that import it (reverse of `dependencies`). */
  dependents: Map<string, Set<string>>;
  /** symbol name → set of files that reference it (excludes the sole definer). */
  xrefs: Map<string, Set<string>>;
}

const RESOLVE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".py", ".go"];

function dirname(posix: string): string {
  const idx = posix.lastIndexOf("/");
  return idx === -1 ? "" : posix.slice(0, idx);
}

function normalize(posix: string): string {
  const parts: string[] = [];
  for (const seg of posix.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Resolve an import specifier written in `fromFile` to an in-repo file path,
 * or `undefined` when it points outside the repo (a bare/external package).
 * Handles relative JS/TS specifiers (with extension inference and index files)
 * and dotted/relative Python modules.
 */
export function resolveImport(spec: string, fromFile: string, fileSet: ReadonlySet<string>): string | undefined {
  // Relative specifier (JS/TS, or Python `.mod` handled below).
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const baseDir = dirname(fromFile);
    const joined = normalize(`${baseDir}/${spec}`);
    return matchModule(joined, fileSet);
  }

  // Python dotted module: `pkg.sub` → `pkg/sub`, leading dots are relative.
  if (fromFile.endsWith(".py")) {
    let rel = spec;
    let baseDir = dirname(fromFile);
    while (rel.startsWith(".")) {
      rel = rel.slice(1);
      // each extra leading dot climbs one directory
      if (rel.startsWith(".")) baseDir = dirname(baseDir);
    }
    const modPath = rel.split(".").join("/");
    const candidate = normalize(baseDir ? `${baseDir}/${modPath}` : modPath);
    const hit = matchModule(candidate, fileSet);
    if (hit) return hit;
    // absolute-from-root python module
    return matchModule(normalize(modPath), fileSet);
  }

  return undefined;
}

const JS_RUNTIME_EXTS = [".js", ".jsx", ".mjs", ".cjs"];

function matchModule(pathNoExt: string, fileSet: ReadonlySet<string>): string | undefined {
  if (fileSet.has(pathNoExt)) return pathNoExt;

  // TS/ESM convention: an import written `./util.js` may resolve to `./util.ts`.
  for (const jsExt of JS_RUNTIME_EXTS) {
    if (pathNoExt.endsWith(jsExt)) {
      const stripped = pathNoExt.slice(0, -jsExt.length);
      for (const tsExt of [".ts", ".tsx", ".mts", ".cts"]) {
        if (fileSet.has(stripped + tsExt)) return stripped + tsExt;
      }
    }
  }

  for (const ext of RESOLVE_EXTS) {
    const cand = pathNoExt + ext;
    if (fileSet.has(cand)) return cand;
  }
  // index / package files
  for (const ext of RESOLVE_EXTS) {
    const cand = `${pathNoExt}/index${ext}`;
    if (fileSet.has(cand)) return cand;
  }
  const pyPkg = `${pathNoExt}/__init__.py`;
  if (fileSet.has(pyPkg)) return pyPkg;
  return undefined;
}

/** Split source into referenceable identifier tokens (for cross-references). */
function identifiers(code: string): Set<string> {
  const out = new Set<string>();
  const re = /[A-Za-z_$][\w$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.add(m[0]);
  return out;
}

const DEFAULT_LANGSET: ReadonlySet<Lang> = new Set(PARSEABLE_LANGS);

/**
 * Build the full {@link RepoIndex} for `root`. Only files whose language the
 * parser understands are read and analysed; the walk still respects ignore
 * rules and size guards.
 */
export async function buildIndex(root: string, opts: BuildIndexOptions = {}): Promise<RepoIndex> {
  const parser = opts.parser ?? heuristicParser;
  const maxReadBytes = opts.maxReadBytes ?? 512_000;
  const langs = opts.langs ?? DEFAULT_LANGSET;

  const walked = await walkProject(root, { ...opts, langs });
  const fileSet = new Set(walked.map((w) => w.path));

  const files = new Map<string, FileInfo>();
  const symbols = new Map<string, SymbolDef[]>();

  // First pass: parse symbols + imports per file.
  const contents = new Map<string, string>();
  for (const entry of walked) {
    const lang = detectLanguage(entry.path);
    if (!isParseable(lang)) continue;
    let code: string;
    try {
      if (entry.bytes > maxReadBytes) continue;
      code = await fs.readFile(entry.absPath, "utf8");
    } catch {
      continue;
    }
    contents.set(entry.path, code);
    const syms = parser.symbols(code, lang);
    const imports = parser.imports(code, lang);
    files.set(entry.path, {
      path: entry.path,
      lang,
      bytes: entry.bytes,
      symbols: syms,
      imports,
      deps: [],
    });
    for (const s of syms) {
      const def: SymbolDef = { ...s, file: entry.path };
      const list = symbols.get(s.name);
      if (list) list.push(def);
      else symbols.set(s.name, [def]);
    }
  }

  // Second pass: resolve imports into dependency edges.
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

  // Third pass: cross-references (symbol name → referencing files). Each
  // file's content is released from `contents` right after it is scanned here
  // (its last use) so the full corpus is never held in memory at once for the
  // duration of this pass — bounding peak memory for large trees.
  const xrefs = new Map<string, Set<string>>();
  for (const [file, code] of contents) {
    const toks = identifiers(code);
    for (const name of toks) {
      const defs = symbols.get(name);
      if (!defs) continue;
      // A cross-reference is a use in a file OTHER than where the symbol is
      // defined. A file that defines the name (even if the same name is also
      // defined elsewhere, e.g. `__init__`) is never counted as referencing it —
      // otherwise every file defining a common member name would spuriously
      // "reference" every other such file.
      if (defs.some((d) => d.file === file)) continue;
      let set = xrefs.get(name);
      if (!set) {
        set = new Set<string>();
        xrefs.set(name, set);
      }
      set.add(file);
    }
    contents.delete(file);
  }

  return { root, files, symbols, dependencies, dependents, xrefs };
}
