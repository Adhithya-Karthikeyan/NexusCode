/**
 * The context-power layer wiring (Wave 5): RAG retrieval, the file-intelligence
 * repo map, and the caching subsystem, glued additively onto the existing engine
 * and Context Engine seams. Nothing here modifies a frozen contract — it composes
 * the already-shipped `@nexuscode/{rag,cache,fileintel}` packages behind small,
 * config-driven factories the CLI commands consume.
 *
 * Everything is offline-verifiable: the default `hashing` embedder is
 * deterministic and network-free, caches live under a temp-overridable dir, and
 * the repo map is a pure function of the walked tree.
 */

import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { nexusPaths, type NexusConfig } from "@nexuscode/config";
import {
  DiskCache,
  EmbeddingCache,
  MemoryCache,
  ResponseCache,
  SessionAffinity,
  applyAffinity,
  buildPrefixCachePlan,
  toAnthropicSystem,
  type AnthropicSystemBlock,
  type CacheStats,
  type CachedResponse,
} from "@nexuscode/cache";
import type { CallContext, Pricing, ProviderAdapter } from "@nexuscode/core";
import {
  EnvSource,
  GitDiffSource,
  MemorySource,
  ProjectConventionsSource,
  type ContextSource,
} from "@nexuscode/context";
import {
  HashingEmbedder,
  RagIndex,
  RagRetrievalSource,
  createOllamaEmbedder,
  createOpenAIEmbedder,
  ragStoreFile,
  type Embedder,
} from "@nexuscode/rag";
import { RepoMapSource, walkProject, type WalkOptions } from "@nexuscode/fileintel";
import { openMemory } from "@nexuscode/memory";

// ── Paths ──────────────────────────────────────────────────────────────────────

/** The cache directory: config override → `NEXUS_CACHE_DIR` → platform cache dir. */
export function cacheDir(config: NexusConfig, env: NodeJS.ProcessEnv = process.env): string {
  return config.cache.dir ?? env["NEXUS_CACHE_DIR"] ?? nexusPaths().cache;
}

/** The persisted RAG index file: config override → data-dir `rag-index.json`. */
export function ragStorePath(config: NexusConfig, env: NodeJS.ProcessEnv = process.env): string {
  return ragStoreFile(config.rag.storeFile, env);
}

// ── Embedders ────────────────────────────────────────────────────────────────

/**
 * Build the embedder named by config. `hashing` is the deterministic offline
 * default (used by tests and when no network embedder is configured); the
 * `ollama`/`openai` seams are real but never exercised offline.
 */
export function makeEmbedder(config: NexusConfig): Embedder {
  const rag = config.rag;
  if (rag.embedder === "ollama") {
    return createOllamaEmbedder({
      model: rag.embedderModel ?? "nomic-embed-text",
      dims: rag.dims,
    });
  }
  if (rag.embedder === "openai") {
    return createOpenAIEmbedder({
      model: rag.embedderModel ?? "text-embedding-3-small",
      dims: rag.dims,
      apiKey: process.env["OPENAI_API_KEY"] ?? "",
    });
  }
  return new HashingEmbedder({ dims: rag.dims });
}

/**
 * Wrap a registered {@link ProviderAdapter}'s native embeddings API as an
 * {@link Embedder} (system-spec §2 "embeddings" + §16). Only adapters that
 * declare `capabilities().embeddings === true` and implement `embed()` are
 * suitable — the caller checks that before constructing this. Each batch is one
 * `adapter.embed()` round-trip; the vector dimensionality is taken from
 * `config.rag.dims` (the adapter's model must produce that width). Never touched
 * by the offline test path (which uses {@link HashingEmbedder}).
 */
export function createProviderEmbedder(
  adapter: ProviderAdapter,
  opts: { dims: number; model?: string },
): Embedder {
  if (typeof adapter.embed !== "function") {
    throw new Error(`provider "${adapter.id}" does not implement embeddings`);
  }
  const embed = adapter.embed.bind(adapter);
  return {
    id: `provider:${adapter.id}${opts.model ? `:${opts.model}` : ""}`,
    dims: opts.dims,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const ctx: CallContext = {
        signal: new AbortController().signal,
        idempotencyKey: `embed:${adapter.id}`,
        traceId: `embed:${adapter.id}`,
        runId: `embed:${adapter.id}`,
      };
      const vectors = await embed(texts, ctx);
      if (vectors.length !== texts.length) {
        throw new Error(`provider "${adapter.id}" embeddings count mismatch: expected ${texts.length}, got ${vectors.length}`);
      }
      return vectors;
    },
  };
}

/**
 * An {@link Embedder} decorator that memoizes vectors through an
 * {@link EmbeddingCache} — the same chunk text is embedded at most once across
 * runs. Only cache misses reach the wrapped embedder; the batch order is
 * preserved. Booked savings are surfaced via {@link CachingEmbedder.stats}.
 */
export class CachingEmbedder implements Embedder {
  readonly id: string;
  readonly dims: number;
  private readonly inner: Embedder;
  private readonly cache: EmbeddingCache;

  constructor(inner: Embedder, cache: EmbeddingCache) {
    this.inner = inner;
    this.id = inner.id;
    this.dims = inner.dims;
    this.cache = cache;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const cached = await this.cache.getMany(this.id, texts);
    const missIndexes: number[] = [];
    const missTexts: string[] = [];
    for (let i = 0; i < texts.length; i++) {
      if (cached[i] === undefined) {
        missIndexes.push(i);
        missTexts.push(texts[i]!);
      }
    }
    const out: number[][] = new Array(texts.length);
    for (let i = 0; i < texts.length; i++) {
      const hit = cached[i];
      if (hit !== undefined) out[i] = hit;
    }
    if (missTexts.length > 0) {
      const fresh = await this.inner.embed(missTexts);
      for (let j = 0; j < missIndexes.length; j++) {
        const idx = missIndexes[j]!;
        const vec = fresh[j]!;
        out[idx] = vec;
        await this.cache.set(this.id, missTexts[j]!, vec);
      }
    }
    return out;
  }

  stats(): Promise<CacheStats> {
    return this.cache.stats();
  }
}

/** Build an {@link EmbeddingCache} over the configured backend (disk/memory). */
export function makeEmbeddingCache(config: NexusConfig): EmbeddingCache {
  const backend =
    config.cache.backend === "memory"
      ? new MemoryCache<number[]>(
          config.cache.ttlMs !== undefined ? { defaultTtlMs: config.cache.ttlMs } : {},
        )
      : new DiskCache<number[]>({
          dir: cacheDir(config),
          namespace: "embeddings",
          ...(config.cache.ttlMs !== undefined ? { defaultTtlMs: config.cache.ttlMs } : {}),
        });
  return new EmbeddingCache({ backend, pricing: pricingTableFrom(config) });
}

// ── RAG index ────────────────────────────────────────────────────────────────

export interface OpenRagIndexOptions {
  /** Wrap the embedder with the embedding cache when the cache is enabled. */
  cached?: boolean;
  /** Load the persisted store if it exists (default true). */
  load?: boolean;
  /**
   * Explicit embedder override. When provided it is used instead of the one
   * `makeEmbedder(config)` would build — the seam through which a real provider
   * embedder ({@link createProviderEmbedder}) is injected. The default (offline
   * `hashing`) path is used when omitted.
   */
  embedder?: Embedder;
}

/**
 * Open the project RAG index (optionally cache-wrapped and pre-loaded from the
 * persisted store). The store dims must match the embedder — a stale index built
 * with a different embedder is detected by {@link RagIndex} on load.
 */
export function openRagIndex(config: NexusConfig, opts: OpenRagIndexOptions = {}): RagIndex {
  const base = opts.embedder ?? makeEmbedder(config);
  const embedder =
    opts.cached && config.cache.embeddings
      ? new CachingEmbedder(base, makeEmbeddingCache(config))
      : base;
  const file = ragStorePath(config);
  const index = new RagIndex({
    embedder,
    file,
    chunk: { chunkSize: config.rag.chunkSize, overlap: config.rag.overlap },
    // Redact secrets before embed/store/persist (blocks remote exfiltration and
    // keeps rag-index.json free of raw credentials). On unless explicitly off.
    redactSecrets: config.rag.secretScan,
    // Stream the embed step in bounded batches instead of one giant batch over
    // the whole corpus (aggregate-memory guard — system-spec §16).
    batchSize: config.rag.embedBatchSize,
  });
  if ((opts.load ?? true) && existsSync(file)) {
    try {
      index.load(file);
    } catch {
      // A store built with a different embedder/dims — ignore and start fresh.
    }
  }
  return index;
}

/** A file selected for indexing plus its text. */
export interface IndexableDoc {
  id: string;
  path: string;
  text: string;
}

/** Heuristic: skip obviously-binary content (a NUL byte in the first slice). */
function looksBinary(text: string): boolean {
  const head = text.slice(0, 4096);
  return head.includes("\u0000");
}

/** `bytes` formatted as MiB with one decimal place, for human-readable log messages. */
function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Walk `root` and read every eligible text/code file into an indexable document.
 * Reuses the file-intelligence ignore-aware walker (so `.gitignore`/`.nexusignore`
 * plus the configured extra globs are honoured) and guards against binaries and
 * oversized files.
 *
 * Two aggregate budgets bound how much this can ever hold in memory at once —
 * `config.rag.maxTotalBytes` (summed document text) and `config.rag.maxTotalChunks`
 * (an estimate of chunks the RAG chunker will later produce, from `chunkSize` /
 * `overlap`). Either cap stops collection early; the walker itself also enforces
 * `fileintel.maxTotalFiles` / `fileintel.maxTotalBytes`. Every truncation is
 * logged to stderr — never silent (system-spec §11/§16 aggregate-memory guard).
 */
export async function collectIndexableDocs(
  root: string,
  config: NexusConfig,
  maxBytes = 512_000,
): Promise<IndexableDoc[]> {
  const walkOpts: WalkOptions = {
    extraIgnore: config.rag.ignore,
    maxFileBytes: maxBytes,
    maxTotalBytes: config.fileintel.maxTotalBytes,
    maxFiles: config.fileintel.maxFiles ?? config.fileintel.maxTotalFiles,
  };
  const entries = await walkProject(root, walkOpts);

  const maxTotalBytes = config.rag.maxTotalBytes;
  const maxTotalChunks = config.rag.maxTotalChunks;
  // Chunks advance by (chunkSize - overlap) characters per step; estimate how
  // many chunks a document's text will yield without actually chunking it yet.
  const chunkStep = Math.max(1, config.rag.chunkSize - config.rag.overlap);

  const docs: IndexableDoc[] = [];
  let totalBytes = 0;
  let estimatedChunks = 0;
  let truncated = false;

  for (const entry of entries) {
    if (entry.bytes > maxBytes) continue;
    if (maxTotalBytes > 0 && totalBytes + entry.bytes > maxTotalBytes) {
      truncated = true;
      break;
    }
    let text: string;
    try {
      text = await fs.readFile(entry.absPath, "utf8");
    } catch {
      continue;
    }
    if (text.trim().length === 0 || looksBinary(text)) continue;

    const chunkEstimate = Math.max(1, Math.ceil(text.length / chunkStep));
    if (maxTotalChunks > 0 && estimatedChunks + chunkEstimate > maxTotalChunks) {
      truncated = true;
      break;
    }

    totalBytes += entry.bytes;
    estimatedChunks += chunkEstimate;
    docs.push({ id: entry.path, path: entry.path, text });
  }

  if (truncated) {
    process.stderr.write(
      `index: reached limit (${docs.length} of ${entries.length} files / ${mib(totalBytes)} MiB) — ` +
        `indexed a subset; raise rag.maxTotalBytes / rag.maxTotalChunks to include more.\n`,
    );
  }

  return docs;
}

// ── Response cache ─────────────────────────────────────────────────────────────

/** Build a `model id → Pricing` table from config (mirrors `pricingTable`). */
export function pricingTableFrom(config: NexusConfig): Record<string, Pricing> {
  const out: Record<string, Pricing> = {};
  for (const [model, entry] of Object.entries(config.pricing)) {
    const p: Pricing = { inputPerMTok: entry.inputPer1M, outputPerMTok: entry.outputPer1M };
    if (entry.cacheReadPer1M !== undefined) p.cacheReadPerMTok = entry.cacheReadPer1M;
    if (entry.cacheWritePer1M !== undefined) p.cacheWritePerMTok = entry.cacheWritePer1M;
    if (entry.reasoningPer1M !== undefined) p.reasoningPerMTok = entry.reasoningPer1M;
    out[model] = p;
  }
  return out;
}

/** Open the {@link ResponseCache} over the configured backend, or `undefined` when disabled. */
export function openResponseCache(config: NexusConfig): ResponseCache | undefined {
  if (!config.cache.enabled || !config.cache.responses) return undefined;
  const backend =
    config.cache.backend === "memory"
      ? new MemoryCache<CachedResponse>(
          config.cache.ttlMs !== undefined ? { defaultTtlMs: config.cache.ttlMs } : {},
        )
      : new DiskCache<CachedResponse>({
          dir: cacheDir(config),
          namespace: "responses",
          ...(config.cache.ttlMs !== undefined ? { defaultTtlMs: config.cache.ttlMs } : {}),
        });
  return new ResponseCache({ backend, pricing: pricingTableFrom(config) });
}

// ── Router cache-affinity ──────────────────────────────────────────────────────

/** Process-wide session→provider affinity map (prompt-cache stickiness). */
let sharedAffinity: SessionAffinity | undefined;

/** The shared {@link SessionAffinity} instance (lazily created). */
export function sessionAffinity(): SessionAffinity {
  if (!sharedAffinity) sharedAffinity = new SessionAffinity();
  return sharedAffinity;
}

/**
 * Reorder router candidates to prefer the session's last-used provider so its
 * provider prompt-cache stays warm — a soft pin that never removes candidates,
 * so live failover still works. A no-op when affinity is disabled or unset.
 */
export function preferAffineProvider<T extends { providerId: string }>(
  config: NexusConfig,
  sessionId: string,
  candidates: readonly T[],
): T[] {
  if (!config.cache.affinity) return [...candidates];
  return applyAffinity(candidates, sessionAffinity().preferred(sessionId));
}

// ── Anthropic prompt-prefix cache injection ─────────────────────────────────────

/**
 * Turn an assembled cache-stable system prefix into Anthropic `system` blocks
 * with `cache_control` on the deepest cacheable boundary (the injection point for
 * the Anthropic adapter path — system-spec §17). Additive: the frozen
 * `system: string` field is untouched; these blocks ride `providerExtensions`.
 */
export function anthropicPrefixBlocks(
  system: string,
  breakpointOffsets: number[] = [],
  maxBreakpoints = 1,
): AnthropicSystemBlock[] {
  const plan = buildPrefixCachePlan(system, breakpointOffsets);
  return toAnthropicSystem(plan.system, { maxBreakpoints });
}

// ── Context sources ─────────────────────────────────────────────────────────────

export interface PowerSourceOptions {
  /** Working directory the repo map / RAG index are rooted at. */
  cwd: string;
  /** Include the durable-memory source (default true). */
  memory?: boolean;
}

/**
 * Assemble the Context Engine source list for a run — the project context every
 * request carries. Out of the box this is what makes the tool behave like a
 * harness rather than a chatbot:
 *
 *   - {@link MemorySource}            durable recalled memory (`retrieved`)
 *   - {@link ProjectConventionsSource} CLAUDE.md / AGENTS.md (static `conventions`)
 *   - {@link RepoMapSource}           structural repo map (static `repo-map`)
 *   - {@link EnvSource}               opted-in env vars (static `env`)
 *   - {@link RagRetrievalSource}      index retrieval (`retrieved`)
 *   - {@link GitDiffSource}           working-tree status/diff (volatile `git`)
 *
 * Ordering here is irrelevant to the output — the engine places chunks by LANE,
 * static prefix first — but every source is bounded, and each is individually
 * disableable via config. Sources that find nothing (no instruction files, not a
 * git repo, no RAG index) contribute zero chunks rather than erroring, and the
 * engine additionally isolates a throwing source so it can never sink the turn.
 *
 * Cost note: the two always-on additions land almost entirely in the CACHE-STABLE
 * static prefix (conventions + repo map), so their tokens are paid once and then
 * served from the provider prompt-cache on subsequent turns of a session.
 */
export function buildPowerSources(config: NexusConfig, opts: PowerSourceOptions): ContextSource[] {
  const sources: ContextSource[] = [];
  if (opts.memory ?? true) sources.push(new MemorySource({ store: openMemory() }));

  // Project conventions: the repo's own rules. Previously only reachable via the
  // manual `nexus memory ingest`, so a fresh user never sent them at all.
  if (config.context.conventions) {
    sources.push(
      new ProjectConventionsSource({
        cwd: opts.cwd,
        maxBytesPerFile: config.context.conventionsMaxBytes,
        maxFiles: config.context.conventionsMaxFiles,
      }),
    );
  }

  if (config.fileintel.repoMap) {
    sources.push(
      new RepoMapSource({
        root: opts.cwd,
        budgetTokens: config.fileintel.budgetTokens,
        extraIgnore: config.fileintel.ignore,
        maxTotalBytes: config.fileintel.maxTotalBytes,
        maxFiles: config.fileintel.maxFiles ?? config.fileintel.maxTotalFiles,
      }),
    );
  }

  // Env is opt-in by key list; with the default empty list this collects nothing.
  if (config.context.envKeys.length > 0) {
    sources.push(new EnvSource({ keys: config.context.envKeys }));
  }

  // `rag.enabled` is a permission, not a promise: retrieval only joins when a
  // persisted, non-empty index actually exists — otherwise it would spend a
  // query to contribute nothing.
  if (config.rag.enabled) {
    const file = ragStorePath(config);
    if (existsSync(file)) {
      const index = openRagIndex(config, { cached: true, load: true });
      if (index.size > 0) {
        sources.push(new RagRetrievalSource({ index, topK: config.rag.topK }));
      }
    }
  }

  // Working-tree state, volatile by construction (it changes every turn), so it
  // sits behind the cacheable prefix and is trimmed before any static context.
  // Outside a git repo the runner yields empty output ⇒ no chunks.
  if (config.context.git) {
    sources.push(new GitDiffSource({ cwd: opts.cwd, maxBytes: config.context.gitMaxBytes }));
  }

  return sources;
}

/** Human-readable one-line summary of a cache dir's on-disk entry counts. */
export async function cacheEntryCounts(
  config: NexusConfig,
): Promise<{ responses: number; embeddings: number }> {
  const dir = cacheDir(config);
  const count = async (ns: string): Promise<number> => {
    const nsDir = join(dir, ns);
    if (!existsSync(nsDir)) return 0;
    try {
      const files = await fs.readdir(nsDir);
      return files.filter((f) => f.endsWith(".json")).length;
    } catch {
      return 0;
    }
  };
  return { responses: await count("responses"), embeddings: await count("embeddings") };
}
