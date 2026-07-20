/**
 * @nexuscode/cache — the caching subsystem (system-spec §17, CAG / Caching).
 *
 * Layers, bottom-up:
 *   - a unified {@link CacheBackend} abstraction with two implementations,
 *     {@link MemoryCache} (LRU + TTL) and {@link DiskCache} (JSON files, 0600);
 *   - typed caches over a backend — {@link PromptCache}, {@link ResponseCache},
 *     {@link EmbeddingCache}, {@link FileCache} — each with a deterministic key
 *     strategy, a default TTL, and {@link CacheAccounting} of tokens/cost saved;
 *   - prompt prefix-cache helpers ({@link toAnthropicSystem},
 *     {@link buildPrefixCachePlan}, {@link PREFIX_STABILITY_CONTRACT}); and
 *   - a cache-affinity routing hook ({@link SessionAffinity} + {@link applyAffinity}).
 *
 * Everything is offline-verifiable: injectable clocks, temp-dir disk caches, and
 * a char/4 default token estimator keep the whole package free of network and
 * wall-clock dependence.
 */

export type {
  BackendMetrics,
  CacheBackend,
  CacheStats,
  Clock,
  Savings,
  SetOptions,
  StoredEntry,
} from "./types.js";

export { CacheAccounting } from "./accounting.js";
export { hashKey, keyToFilename, stableStringify } from "./keys.js";

export { MemoryCache } from "./backends/memory.js";
export type { MemoryCacheOptions } from "./backends/memory.js";
export { DiskCache } from "./backends/disk.js";
export type { DiskCacheOptions } from "./backends/disk.js";

export { PromptCache } from "./typed/prompt.js";
export type { PromptCacheOptions, PromptCacheValue } from "./typed/prompt.js";
export { ResponseCache, signatureOf } from "./typed/response.js";
export type {
  CachedResponse,
  ResponseCacheOptions,
  ResponseSignature,
} from "./typed/response.js";
export { EmbeddingCache } from "./typed/embedding.js";
export type { EmbeddingCacheOptions } from "./typed/embedding.js";
export { FileCache } from "./typed/file.js";
export type { FileCacheEntry, FileCacheOptions, FileFingerprint } from "./typed/file.js";

export {
  PREFIX_STABILITY_CONTRACT,
  assertStablePrefix,
  buildPrefixCachePlan,
  prefixCacheKey,
  toAnthropicSystem,
} from "./prefix.js";
export type {
  AnthropicCacheControl,
  AnthropicSystemBlock,
  PrefixCachePlan,
  ToAnthropicSystemOptions,
} from "./prefix.js";

export { SessionAffinity, applyAffinity } from "./affinity.js";
export type { SessionAffinityOptions } from "./affinity.js";
