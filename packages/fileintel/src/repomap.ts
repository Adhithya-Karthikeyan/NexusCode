/**
 * Repo map (system-spec §11, aider-style) — the structural context source.
 * Ranks the repository's most important symbols via PageRank over a graph built
 * from cross-references (a file that references another file's symbols "votes"
 * for the definer), then renders a compact, signatures-only map packed under a
 * token budget. Deterministic and offline.
 */

import { defaultEstimator, type TokenEstimator } from "@nexuscode/context";
import { buildIndex, type BuildIndexOptions, type RepoIndex } from "./index-build.js";
import type { SymbolKind } from "./parser.js";

/** A symbol with its computed structural importance. */
export interface RankedSymbol {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  signature: string;
  /** PageRank-derived importance (higher = more central). */
  rank: number;
  /** Number of distinct files that reference this symbol. */
  refs: number;
}

/** A file plus its ranked symbols, in the rendered map. */
export interface RepoMapEntry {
  file: string;
  symbols: RankedSymbol[];
}

/** The rendered repo map. */
export interface RepoMap {
  /** The compact, signatures-only, token-budgeted map text. */
  text: string;
  /** Estimated tokens of {@link RepoMap.text} — always ≤ `budgetTokens`. */
  tokens: number;
  budgetTokens: number;
  /** Files included in the rendered map, in ranked order. */
  files: RepoMapEntry[];
  /** All symbols in global ranked order (may exceed what fit in the budget). */
  ranked: RankedSymbol[];
  /** `true` when some ranked symbols were dropped to respect the budget. */
  truncated: boolean;
}

export interface RepoMapOptions extends BuildIndexOptions {
  /** Token budget for the rendered map (default 1024). */
  budgetTokens?: number;
  /** Token estimator (default the Context Engine's char/4 estimator). */
  estimate?: TokenEstimator;
  /** A pre-built index to rank (skips walking/parsing when supplied). */
  index?: RepoIndex;
  /** PageRank damping factor (default 0.85). */
  damping?: number;
}

/**
 * PageRank over a weighted directed graph. `edges` maps a node to its outgoing
 * neighbours with weights. Returns a node → score map summing to ~1.
 */
export function pageRank(
  nodes: readonly string[],
  edges: ReadonlyMap<string, ReadonlyMap<string, number>>,
  opts: { damping?: number; iterations?: number; tolerance?: number } = {},
): Map<string, number> {
  const damping = opts.damping ?? 0.85;
  const iterations = opts.iterations ?? 100;
  const tolerance = opts.tolerance ?? 1e-9;
  const n = nodes.length;
  const rank = new Map<string, number>();
  if (n === 0) return rank;

  const outWeight = new Map<string, number>();
  for (const node of nodes) {
    const out = edges.get(node);
    let sum = 0;
    if (out) for (const w of out.values()) sum += w;
    outWeight.set(node, sum);
    rank.set(node, 1 / n);
  }

  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const node of nodes) {
      if ((outWeight.get(node) ?? 0) === 0) dangling += rank.get(node) ?? 0;
    }
    const base = (1 - damping) / n + (damping * dangling) / n;
    for (const node of nodes) next.set(node, base);

    for (const node of nodes) {
      const out = edges.get(node);
      const total = outWeight.get(node) ?? 0;
      if (!out || total === 0) continue;
      const share = (damping * (rank.get(node) ?? 0)) / total;
      for (const [target, w] of out) {
        next.set(target, (next.get(target) ?? 0) + share * w);
      }
    }

    let delta = 0;
    for (const node of nodes) delta += Math.abs((next.get(node) ?? 0) - (rank.get(node) ?? 0));
    for (const node of nodes) rank.set(node, next.get(node) ?? 0);
    if (delta < tolerance) break;
  }

  return rank;
}

/**
 * Rank every defined symbol in the index. File importance flows from symbol
 * cross-references (referencer → definer) via PageRank; each file's importance
 * is then distributed across its symbols in proportion to how many files
 * reference each one. Ties break deterministically by refs, then name.
 */
export function rankSymbols(index: RepoIndex, opts: { damping?: number } = {}): RankedSymbol[] {
  const fileNodes = [...index.files.keys()].sort();

  // Build weighted file→file edges: referencer → definer, weighted by how many
  // of the definer's symbols the referencer touches.
  const edges = new Map<string, Map<string, number>>();
  for (const [name, referencingFiles] of index.xrefs) {
    const defs = index.symbols.get(name);
    if (!defs) continue;
    // Ambiguous names (defined in several files, e.g. `__init__`, `run`) are
    // weaker signals: split their weight across definition sites so a common
    // method name can't dominate — and can't form spurious reciprocal cycles.
    const weight = 1 / defs.length;
    for (const def of defs) {
      const definer = def.file;
      for (const referencer of referencingFiles) {
        if (referencer === definer) continue;
        let out = edges.get(referencer);
        if (!out) {
          out = new Map<string, number>();
          edges.set(referencer, out);
        }
        out.set(definer, (out.get(definer) ?? 0) + weight);
      }
    }
  }

  const fileRank = pageRank(fileNodes, edges, { damping: opts.damping ?? 0.85 });

  const ranked: RankedSymbol[] = [];
  for (const [file, info] of index.files) {
    const fr = fileRank.get(file) ?? 0;
    // Weight = 1 + number of external referencing files for this symbol name.
    const weights: Array<{ sym: (typeof info.symbols)[number]; refs: number; weight: number }> = [];
    let totalWeight = 0;
    for (const sym of info.symbols) {
      const refFiles = index.xrefs.get(sym.name);
      const refs = refFiles ? [...refFiles].filter((f) => f !== file).length : 0;
      const defSites = index.symbols.get(sym.name)?.length ?? 1;
      // Uniquely-defined, widely-referenced symbols carry the most weight.
      const weight = (1 + refs) / defSites;
      totalWeight += weight;
      weights.push({ sym, refs, weight });
    }
    for (const { sym, refs, weight } of weights) {
      const share = totalWeight > 0 ? weight / totalWeight : 0;
      ranked.push({
        name: sym.name,
        kind: sym.kind,
        file,
        line: sym.line,
        signature: sym.signature,
        rank: fr * share + refs * 1e-6, // refs is a deterministic tiebreaker
        refs,
      });
    }
  }

  ranked.sort((a, b) => {
    if (b.rank !== a.rank) return b.rank - a.rank;
    if (b.refs !== a.refs) return b.refs - a.refs;
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    return a.name < b.name ? -1 : 1;
  });
  return ranked;
}

function symbolLine(sym: RankedSymbol): string {
  return `  ${sym.signature}`;
}

/**
 * Build and render the repo map for `root`. Ranks symbols, groups them under
 * their files in ranked order, and renders signatures only until the token
 * budget is reached (guaranteeing `tokens ≤ budgetTokens`).
 */
export async function repoMap(root: string, opts: RepoMapOptions = {}): Promise<RepoMap> {
  const budgetTokens = opts.budgetTokens ?? 1024;
  const estimate = opts.estimate ?? defaultEstimator;
  const index = opts.index ?? (await buildIndex(root, opts));
  const ranked = rankSymbols(index, { ...(opts.damping !== undefined ? { damping: opts.damping } : {}) });

  // Order files by their single best-ranked symbol; keep symbols within a file
  // in ranked order too.
  const bestByFile = new Map<string, number>();
  const symsByFile = new Map<string, RankedSymbol[]>();
  for (const sym of ranked) {
    const prev = bestByFile.get(sym.file);
    if (prev === undefined || sym.rank > prev) bestByFile.set(sym.file, sym.rank);
    const list = symsByFile.get(sym.file);
    if (list) list.push(sym);
    else symsByFile.set(sym.file, [sym]);
  }
  const orderedFiles = [...symsByFile.keys()].sort((a, b) => {
    const ra = bestByFile.get(a) ?? 0;
    const rb = bestByFile.get(b) ?? 0;
    if (rb !== ra) return rb - ra;
    return a < b ? -1 : 1;
  });

  const files: RepoMapEntry[] = [];
  let text = "";
  let tokens = 0;
  let truncated = false;
  let dropped = 0;
  let totalSymbols = 0;

  for (const file of orderedFiles) {
    const fileSyms = symsByFile.get(file) ?? [];
    totalSymbols += fileSyms.length;
    const header = `${file}:`;
    const withHeader = text.length === 0 ? header : `${text}\n${header}`;
    if (estimate(withHeader) > budgetTokens) {
      truncated = true;
      dropped += fileSyms.length;
      continue;
    }
    let pending = withHeader;
    let pendingTokens = estimate(pending);
    const included: RankedSymbol[] = [];
    for (const sym of fileSyms) {
      const candidate = `${pending}\n${symbolLine(sym)}`;
      const candTokens = estimate(candidate);
      if (candTokens > budgetTokens) {
        truncated = true;
        dropped++;
        continue;
      }
      pending = candidate;
      pendingTokens = candTokens;
      included.push(sym);
    }
    if (included.length === 0) {
      // Header alone isn't worth emitting.
      truncated = truncated || fileSyms.length > 0;
      continue;
    }
    text = pending;
    tokens = pendingTokens;
    files.push({ file, symbols: included });
  }

  if (dropped === 0 && files.reduce((n, f) => n + f.symbols.length, 0) < totalSymbols) {
    truncated = true;
  }

  return { text, tokens, budgetTokens, files, ranked, truncated };
}
