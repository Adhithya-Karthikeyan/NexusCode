/**
 * web-tree-sitter SEAM (system-spec §11).
 *
 * This module documents and wires the *optional* WASM tree-sitter backend
 * WITHOUT taking a hard dependency on it. The offline-verifiable invariant
 * requires that `@nexuscode/fileintel` always installs and builds, so we must
 * NOT depend on the native `tree-sitter` (node-gyp) bindings, which frequently
 * fail to compile. Instead:
 *
 *   1. The shipped default is the dependency-free {@link HeuristicParser}.
 *   2. For full-fidelity ASTs, a host can install `web-tree-sitter` (a pure-WASM
 *      package, no native toolchain) plus the per-language `.wasm` grammars, and
 *      construct a {@link WasmParser} with a {@link WasmTreeSitter} loader.
 *
 * The loader is injected (not imported) so this package never resolves
 * `web-tree-sitter` at build time. When no loader is provided, {@link WasmParser}
 * transparently falls back to the heuristic parser, so callers get a working
 * result everywhere.
 */

import type { Lang } from "./language.js";
import { HeuristicParser } from "./heuristic.js";
import type { CodeSymbol, Parser } from "./parser.js";

/** A minimal structural view of a web-tree-sitter node (duck-typed). */
export interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  childForFieldName(field: string): TsNode | null;
  namedChildren: TsNode[];
}

/** A parsed tree, as returned by web-tree-sitter's `Parser.parse`. */
export interface TsTree {
  rootNode: TsNode;
}

/**
 * The injected loader contract. A host implements this over `web-tree-sitter`:
 * `parse(code, lang)` returns a {@link TsTree}, or `null` when the grammar for
 * `lang` is unavailable (the {@link WasmParser} then falls back to heuristics).
 */
export interface WasmTreeSitter {
  parse(code: string, lang: Lang): TsTree | null;
}

/**
 * A {@link Parser} backed by an injected web-tree-sitter loader, with automatic
 * heuristic fallback. Symbol extraction from the AST is delegated to a
 * per-language visitor supplied by the loader integration; when absent, the
 * heuristic parser handles the language. This keeps the seam real and callable
 * while never forcing a native compile.
 */
export class WasmParser implements Parser {
  private readonly fallback = new HeuristicParser();

  constructor(
    private readonly loader?: WasmTreeSitter,
    private readonly visit?: (tree: TsTree, lang: Lang) => { symbols: CodeSymbol[]; imports: string[] },
  ) {}

  symbols(code: string, lang: Lang): CodeSymbol[] {
    if (this.loader && this.visit) {
      const tree = this.loader.parse(code, lang);
      if (tree) return this.visit(tree, lang).symbols;
    }
    return this.fallback.symbols(code, lang);
  }

  imports(code: string, lang: Lang): string[] {
    if (this.loader && this.visit) {
      const tree = this.loader.parse(code, lang);
      if (tree) return this.visit(tree, lang).imports;
    }
    return this.fallback.imports(code, lang);
  }
}
