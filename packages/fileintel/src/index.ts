/**
 * @nexuscode/fileintel — File Intelligence (system-spec §11).
 *
 * Provides: language detection (extension + shebang + content heuristics), an
 * ignore-aware project tree walker with large-file guards, a {@link Parser} SEAM
 * with a shipped dependency-free {@link HeuristicParser} and a documented
 * web-tree-sitter seam ({@link WasmParser}), a symbol index / dependency graph /
 * cross-reference index ({@link buildIndex}), and an aider-style, PageRank-ranked,
 * token-budgeted repo map ({@link repoMap}) that plugs into the Context Engine as
 * the structural {@link RepoMapSource}.
 *
 * Everything here is deterministic and offline: no native compile, no network.
 */

export {
  detectLanguage,
  detectDetailed,
  detectFromShebang,
  detectFromContent,
  isParseable,
  PARSEABLE_LANGS,
  type Lang,
  type Detection,
  type DetectMethod,
} from "./language.js";

export type { CodeSymbol, Symbol, Parser, SymbolKind } from "./parser.js";

export { HeuristicParser, heuristicParser } from "./heuristic.js";

export {
  WasmParser,
  type WasmTreeSitter,
  type TsNode,
  type TsTree,
} from "./treesitter.js";

export {
  walkProject,
  compileIgnore,
  matchesAny,
  DEFAULT_IGNORE_FILES,
  DEFAULT_SECRET_IGNORE,
  DEFAULT_MAX_FILE_BYTES,
  type WalkOptions,
  type WalkEntry,
} from "./walk.js";

export {
  buildIndex,
  resolveImport,
  type RepoIndex,
  type FileInfo,
  type SymbolDef,
  type BuildIndexOptions,
} from "./index-build.js";

export {
  repoMap,
  rankSymbols,
  pageRank,
  type RepoMap,
  type RepoMapEntry,
  type RepoMapOptions,
  type RankedSymbol,
} from "./repomap.js";

// Incremental reindex + watch mode (system-spec §23).
export {
  IncrementalRepoIndexer,
  type IncrementalIndexOptions,
  type IncrementalUpdate,
} from "./incremental.js";

export {
  watchProject,
  type WatchProjectOptions,
  type WatchHandle,
  type WatchSource,
} from "./watch.js";

export { RepoMapSource, type RepoMapSourceOptions } from "./source.js";
