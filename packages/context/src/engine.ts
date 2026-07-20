/**
 * The Context Engine (system-spec §3). Given a token budget, a set of sources,
 * and the user's message, it:
 *   1. collects chunks from every source (in parallel),
 *   2. DEDUPES near-identical chunks (keeping the highest-scoring copy),
 *   3. COMPRESSES oversized chunks (head+tail truncation seam),
 *   4. RANKS by relevance + priority and packs within the budget, trimming
 *      tail-first (most volatile lane, least relevant) so pinned items and the
 *      cacheable static prefix survive,
 *   5. renders a cache-stable `system` prefix (STATIC lanes, deterministic
 *      serialization) + volatile `messages`, and a full {@link ContextReport}.
 *
 * Cache invariant: STATIC lanes always precede VOLATILE lanes, static content is
 * serialized without per-request timestamps, and compaction (trimming) only ever
 * removes from the volatile tail — so the provider prompt-cache prefix stays
 * byte-identical turn-to-turn.
 */

import type { ContentBlock, Message } from "@nexuscode/shared";
import { truncateMiddle } from "./compress.js";
import {
  STATIC_LANES,
  VOLATILE_LANES,
  laneIndex,
  laneKind,
  laneTitle,
} from "./lanes.js";
import { defaultEstimator } from "./tokens.js";
import type {
  AssembleOptions,
  AssembleResult,
  Breakpoint,
  CompressedChunk,
  ContextChunk,
  ContextLane,
  ContextReport,
  ContextSource,
  DroppedChunk,
  IncludedChunk,
  LaneReport,
  SourceReport,
  TokenEstimator,
} from "./types.js";

/** A chunk with all engine-managed fields resolved. */
interface ResolvedChunk {
  id: string;
  sourceId: string;
  lane: ContextLane;
  text: string;
  role: Message["role"];
  tokens: number;
  relevance: number;
  priority: number;
  pinned: boolean;
  createdAt: number;
  title: string;
  /** Raw token count before any compression (for nominal accounting). */
  rawTokens: number;
}

export class ContextEngine {
  async assemble(opts: AssembleOptions): Promise<AssembleResult> {
    const estimate: TokenEstimator = opts.estimate ?? defaultEstimator;
    const compress = opts.compress ?? truncateMiddle;
    const now = opts.now ?? Date.now();
    const cwd = opts.cwd ?? process.cwd();
    const priorityWeight = opts.priorityWeight ?? 1;
    const maxBreakpoints = opts.maxBreakpoints ?? 4;
    const budget = opts.budgetTokens;

    const collectCtx = {
      userMessage: opts.userMessage,
      cwd,
      now,
      estimate,
      ...(opts.signal ? { signal: opts.signal } : {}),
    };

    // 1. Collect from every source in parallel. A failing source contributes
    //    nothing but never sinks the whole assembly.
    const collected = await Promise.all(
      opts.sources.map(async (src) => {
        try {
          const chunks = await src.collect(collectCtx);
          return { src, chunks };
        } catch {
          return { src, chunks: [] as ContextChunk[] };
        }
      }),
    );

    const perSourceCollected = new Map<string, number>();
    let resolved: ResolvedChunk[] = [];
    for (const { src, chunks } of collected) {
      perSourceCollected.set(src.id, (perSourceCollected.get(src.id) ?? 0) + chunks.length);
      for (let i = 0; i < chunks.length; i++) {
        resolved.push(resolveChunk(chunks[i]!, src, i, now, estimate));
      }
    }

    const userMessageTokens = estimate(opts.userMessage);
    const nominalTokens =
      resolved.reduce((sum, c) => sum + c.rawTokens, 0) + userMessageTokens;

    // 2. Dedupe. Deterministic winner: highest score, then lane, then id.
    const dropped: DroppedChunk[] = [];
    resolved = dedupe(resolved, priorityWeight, dropped);

    // 3. Compress oversized chunks (per-chunk cap). Pinned chunks are left whole.
    const compressed: CompressedChunk[] = [];
    if (typeof opts.maxChunkTokens === "number") {
      const cap = opts.maxChunkTokens;
      for (const c of resolved) {
        if (c.pinned || c.tokens <= cap) continue;
        const before = c.tokens;
        const r = compress(c.text, cap, estimate);
        if (r.summarized) {
          c.text = r.text;
          c.tokens = r.tokens;
          compressed.push({
            id: c.id,
            sourceId: c.sourceId,
            lane: c.lane,
            fromTokens: before,
            toTokens: r.tokens,
          });
        }
      }
    }

    // 4. Rank into canonical assembly order (prefix → tail).
    const ordered = orderChunks(resolved, priorityWeight);

    // 5. Pack under budget: trim tail-first, never touching pinned chunks.
    const { included, packDropped, realTokens, overBudget } = pack(
      ordered,
      budget,
      userMessageTokens,
      priorityWeight,
    );
    dropped.push(...packDropped);

    // 6. Render.
    const includedStatic = included.filter((c) => laneKind(c.lane) === "static");
    const includedVolatile = included.filter((c) => laneKind(c.lane) === "volatile");
    const system = renderStatic(includedStatic);
    const { messages, preamble } = renderVolatile(includedVolatile, opts.userMessage);

    // Reporting.
    const report = buildReport({
      budget,
      nominalTokens,
      realTokens,
      overBudget,
      userMessageTokens,
      included,
      dropped,
      compressed,
      sources: opts.sources,
      perSourceCollected,
      estimate,
      maxBreakpoints,
    });

    const result: AssembleResult = { system, messages, report };
    // Surfaced separately so a caller that supplies its OWN conversation (and so
    // must discard the engine's reconstructed last turn) can still splice the
    // volatile context in, instead of losing it with that message.
    if (preamble.length > 0) result.volatilePreamble = preamble;
    return result;
  }
}

// ── Resolution ────────────────────────────────────────────────────────────────

function resolveChunk(
  chunk: ContextChunk,
  src: ContextSource,
  index: number,
  now: number,
  estimate: TokenEstimator,
): ResolvedChunk {
  const tokens = typeof chunk.tokens === "number" ? chunk.tokens : estimate(chunk.text);
  return {
    id: chunk.id,
    sourceId: chunk.sourceId ?? src.id,
    lane: chunk.lane,
    text: chunk.text,
    role: chunk.role ?? "user",
    tokens,
    rawTokens: tokens,
    relevance: clamp01(chunk.relevance ?? 0.5),
    priority: chunk.priority ?? src.priority,
    pinned: chunk.pinned ?? false,
    createdAt: chunk.createdAt ?? now + index,
    title: chunk.title ?? laneTitle(chunk.lane),
  };
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function score(c: ResolvedChunk, priorityWeight: number): number {
  return c.priority * priorityWeight + c.relevance;
}

// ── Dedupe ──────────────────────────────────────────────────────────────────

function normalizeKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

function dedupe(
  chunks: ResolvedChunk[],
  priorityWeight: number,
  dropped: DroppedChunk[],
): ResolvedChunk[] {
  // Consider the strongest copy first so it wins the key.
  const byStrength = [...chunks].sort((a, b) => {
    const s = score(b, priorityWeight) - score(a, priorityWeight);
    if (s !== 0) return s;
    const li = laneIndex(a.lane) - laneIndex(b.lane);
    if (li !== 0) return li;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const seen = new Map<string, ResolvedChunk>();
  const winners: ResolvedChunk[] = [];
  for (const c of byStrength) {
    const key = normalizeKey(c.text);
    if (key.length === 0) {
      winners.push(c);
      continue;
    }
    const prior = seen.get(key);
    if (prior) {
      dropped.push({
        id: c.id,
        sourceId: c.sourceId,
        lane: c.lane,
        tokens: c.tokens,
        reason: "duplicate",
      });
      continue;
    }
    seen.set(key, c);
    winners.push(c);
  }
  return winners;
}

// ── Ordering ──────────────────────────────────────────────────────────────────

function orderChunks(chunks: ResolvedChunk[], priorityWeight: number): ResolvedChunk[] {
  return [...chunks].sort((a, b) => {
    const li = laneIndex(a.lane) - laneIndex(b.lane);
    if (li !== 0) return li;
    // Chronological lanes stay in time order for readability + cache stability.
    if (a.lane === "history" || a.lane === "task") {
      if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    // Everything else: strongest first, deterministic on ties.
    const s = score(b, priorityWeight) - score(a, priorityWeight);
    if (s !== 0) return s;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

// ── Packing ────────────────────────────────────────────────────────────────────

interface PackResult {
  included: ResolvedChunk[];
  packDropped: DroppedChunk[];
  realTokens: number;
  overBudget: boolean;
}

function pack(
  ordered: ResolvedChunk[],
  budget: number,
  fixedTokens: number,
  priorityWeight: number,
): PackResult {
  let total = ordered.reduce((s, c) => s + c.tokens, fixedTokens);
  const packDropped: DroppedChunk[] = [];
  const dropIds = new Set<string>();

  if (total > budget) {
    // Least valuable first: most volatile lane, then lowest relevance, then
    // lowest priority. Pinned chunks are never candidates.
    const trimCandidates = ordered
      .filter((c) => !c.pinned)
      .sort((a, b) => {
        const li = laneIndex(b.lane) - laneIndex(a.lane);
        if (li !== 0) return li;
        if (a.relevance !== b.relevance) return a.relevance - b.relevance;
        const s = score(a, priorityWeight) - score(b, priorityWeight);
        if (s !== 0) return s;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      });
    for (const c of trimCandidates) {
      if (total <= budget) break;
      dropIds.add(c.id);
      total -= c.tokens;
      packDropped.push({
        id: c.id,
        sourceId: c.sourceId,
        lane: c.lane,
        tokens: c.tokens,
        reason: "budget",
      });
    }
  }

  const included = ordered.filter((c) => !dropIds.has(c.id));
  const realTokens = included.reduce((s, c) => s + c.tokens, fixedTokens);
  return { included, packDropped, realTokens, overBudget: realTokens > budget };
}

// ── Rendering ──────────────────────────────────────────────────────────────────

function renderChunk(c: ResolvedChunk): string {
  return c.text;
}

function renderStatic(chunks: ResolvedChunk[]): string {
  const sections: string[] = [];
  for (const lane of STATIC_LANES) {
    const laneChunks = chunks.filter((c) => c.lane === lane);
    if (laneChunks.length === 0) continue;
    const body = laneChunks.map(renderChunk).join("\n\n");
    sections.push(`# ${laneTitle(lane)}\n${body}`);
  }
  return sections.join("\n\n");
}

function renderVolatile(
  chunks: ResolvedChunk[],
  userMessage: string,
): { messages: Message[]; preamble: string } {
  const messages: Message[] = [];

  // History turns become real messages, in chronological order.
  const history = chunks
    .filter((c) => c.lane === "history")
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  for (const h of history) {
    messages.push({ role: h.role, content: [{ type: "text", text: h.text }] });
  }

  // Remaining volatile context (retrieved / git / terminal / task) is bundled
  // as a labeled preamble on the final user turn, ahead of the query itself.
  const preambleLanes: ContextLane[] = VOLATILE_LANES.filter((l) => l !== "history");
  const preambleSections: string[] = [];
  for (const lane of preambleLanes) {
    const laneChunks = chunks.filter((c) => c.lane === lane);
    if (laneChunks.length === 0) continue;
    const body = laneChunks.map(renderChunk).join("\n\n");
    preambleSections.push(`# ${laneTitle(lane)}\n${body}`);
  }

  const preamble = preambleSections.join("\n\n");
  const content: ContentBlock[] = [];
  if (preamble.length > 0) {
    content.push({ type: "text", text: preamble });
  }
  content.push({ type: "text", text: userMessage });
  messages.push({ role: "user", content });

  return { messages, preamble };
}

// ── Reporting ──────────────────────────────────────────────────────────────────

interface BuildReportArgs {
  budget: number;
  nominalTokens: number;
  realTokens: number;
  overBudget: boolean;
  userMessageTokens: number;
  included: ResolvedChunk[];
  dropped: DroppedChunk[];
  compressed: CompressedChunk[];
  sources: ContextSource[];
  perSourceCollected: Map<string, number>;
  estimate: TokenEstimator;
  maxBreakpoints: number;
}

function buildReport(args: BuildReportArgs): ContextReport {
  const includedReports: IncludedChunk[] = args.included.map((c) => ({
    id: c.id,
    sourceId: c.sourceId,
    lane: c.lane,
    kind: laneKind(c.lane),
    tokens: c.tokens,
    relevance: c.relevance,
    pinned: c.pinned,
  }));

  // Per-lane accounting.
  const laneAgg = new Map<ContextLane, { tokens: number; count: number }>();
  for (const c of args.included) {
    const cur = laneAgg.get(c.lane) ?? { tokens: 0, count: 0 };
    cur.tokens += c.tokens;
    cur.count += 1;
    laneAgg.set(c.lane, cur);
  }
  const lanes: LaneReport[] = [];
  for (const [lane, agg] of [...laneAgg.entries()].sort(
    (a, b) => laneIndex(a[0]) - laneIndex(b[0]),
  )) {
    lanes.push({ lane, kind: laneKind(lane), tokens: agg.tokens, count: agg.count });
  }

  const staticTokens = args.included
    .filter((c) => laneKind(c.lane) === "static")
    .reduce((s, c) => s + c.tokens, 0);
  const volatileTokens = args.included
    .filter((c) => laneKind(c.lane) === "volatile")
    .reduce((s, c) => s + c.tokens, 0);

  // Per-source accounting.
  const perSourceIncluded = new Map<string, { count: number; tokens: number }>();
  for (const c of args.included) {
    const cur = perSourceIncluded.get(c.sourceId) ?? { count: 0, tokens: 0 };
    cur.count += 1;
    cur.tokens += c.tokens;
    perSourceIncluded.set(c.sourceId, cur);
  }
  const perSourceDropped = new Map<string, number>();
  for (const d of args.dropped) {
    perSourceDropped.set(d.sourceId, (perSourceDropped.get(d.sourceId) ?? 0) + 1);
  }
  const sources: SourceReport[] = args.sources.map((s) => {
    const inc = perSourceIncluded.get(s.id) ?? { count: 0, tokens: 0 };
    return {
      id: s.id,
      kind: s.kind,
      priority: s.priority,
      collected: args.perSourceCollected.get(s.id) ?? 0,
      included: inc.count,
      dropped: perSourceDropped.get(s.id) ?? 0,
      tokens: inc.tokens,
    };
  });

  // Cache breakpoints: cumulative offset at the end of each non-empty static
  // lane, capped at `maxBreakpoints` (keep the largest/latest boundaries).
  const allBreakpoints: Breakpoint[] = [];
  let cumulative = 0;
  for (const lane of STATIC_LANES) {
    const agg = laneAgg.get(lane);
    if (!agg || agg.tokens === 0) continue;
    cumulative += agg.tokens;
    allBreakpoints.push({ lane, tokenOffset: cumulative });
  }
  const breakpoints =
    allBreakpoints.length > args.maxBreakpoints
      ? allBreakpoints.slice(allBreakpoints.length - args.maxBreakpoints)
      : allBreakpoints;

  return {
    budgetTokens: args.budget,
    nominalTokens: args.nominalTokens,
    realTokens: args.realTokens,
    overBudget: args.overBudget,
    staticTokens,
    volatileTokens,
    userMessageTokens: args.userMessageTokens,
    stablePrefixTokens: staticTokens,
    included: includedReports,
    dropped: args.dropped,
    compressed: args.compressed,
    lanes,
    sources,
    breakpoints,
  };
}
