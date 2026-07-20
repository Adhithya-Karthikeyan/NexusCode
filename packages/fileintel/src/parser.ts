/**
 * The Parser SEAM (system-spec §11). A {@link Parser} extracts top-level
 * definitions and import specifiers from a blob of source code for a given
 * {@link Lang}. NexusCode ships a dependency-free {@link HeuristicParser} and a
 * documented web-tree-sitter seam ({@link WasmParser}); callers may supply their
 * own implementation. Nothing here requires a native (node-gyp) build, so the
 * package always installs and builds — the offline-verifiable invariant.
 */

import type { Lang } from "./language.js";

/** The kind of a definition. */
export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "interface"
  | "type"
  | "enum"
  | "const"
  | "variable"
  | "struct";

/** A single top-level (or class-member) definition found in a source file. */
export interface CodeSymbol {
  /** The declared identifier. */
  name: string;
  /** What kind of definition it is. */
  kind: SymbolKind;
  /** 1-based line where the definition begins. */
  line: number;
  /** Whether the definition is exported / public. */
  exported: boolean;
  /** The (trimmed, single-line) declaration signature. */
  signature: string;
  /** Enclosing type name for methods; absent for top-level symbols. */
  container?: string;
}

/**
 * Alias matching the spec's `Symbol[]` wording. (`CodeSymbol` is the canonical
 * name to avoid shadowing the JS global `Symbol` in consumer code.)
 */
export type Symbol = CodeSymbol;

/**
 * The parser contract. Implementations must be pure and deterministic: same
 * `(code, lang)` in → same symbols/imports out, no filesystem or network.
 */
export interface Parser {
  /** Extract definitions from `code`. Returns `[]` for unsupported languages. */
  symbols(code: string, lang: Lang): CodeSymbol[];
  /** Extract import/require module specifiers from `code`, de-duplicated. */
  imports(code: string, lang: Lang): string[];
}
