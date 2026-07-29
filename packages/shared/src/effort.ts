/**
 * A tiny TTL memoizer for provider reasoning-EFFORT discovery — the effort
 * analog of `model-cache.ts`'s `createModelListCache`, deliberately a
 * separate small type rather than a generic reuse of the model cache: the
 * payload shape is different (`levels`/`defaultLevel`, not `models`), and
 * keeping the two symmetric-but-distinct mirrors this repo's existing
 * per-concept-cache convention (see `model-cache.ts`'s own doc comment).
 *
 * Why this exists at all: a wrapped coding CLI (claude-code, codex) has its
 * OWN reasoning-effort vocabulary — claude-code's `/effort` accepts
 * `low|medium|high|xhigh|max|ultracode|auto`; codex's accepted set is
 * MODEL-DEPENDENT and pulled from `codex debug models`. Neither is a fixed
 * enum NexusCode can hardcode without it going stale the moment the vendor
 * CLI ships a new level (exactly the bug class `ModelListResult`/
 * `ModelListSource` already closed for model discovery) — so effort options
 * are probed live, the same way, with the same fallback discipline.
 */

/**
 * Whether an effort-level list actually came from asking the provider (a
 * live, THIS-RUN probe that reached the CLI/backend and got a real answer)
 * or is the built-in/config fallback (no way to probe, the probe failed, or
 * the adapter has no live discovery for this axis at all). Same two-value
 * discipline as `ModelListSource` — see its doc comment for why this is
 * deliberately NOT a boolean and NOT three-valued.
 */
export type EffortListSource = "provider" | "fallback";

/** One reasoning-effort level a provider actually accepts, verbatim. */
export interface EffortLevelInfo {
  /** Provider-native level name, sent on the wire EXACTLY as reported — never
   *  renamed/normalized to NexusCode's own vocabulary. */
  id: string;
  /** Human-readable description, when the provider supplies one (e.g.
   *  codex's `debug models` catalog carries a sentence per level). Omitted
   *  when the provider's own reply carries no such text (claude-code's
   *  `/effort` usage string is bare names only). */
  description?: string;
}

/** An effort-level list plus where it came from and the provider's own default. */
export interface EffortListResult {
  /** Ordered EXACTLY as the provider reported them — never re-sorted. */
  levels: EffortLevelInfo[];
  /** The provider's own current/default level, when it reports one (e.g.
   *  codex's `default_reasoning_level`, or the value already configured in
   *  `~/.codex/config.toml`). Omitted when unknown. */
  defaultLevel?: string;
  source: EffortListSource;
}

export interface EffortListCache {
  /**
   * Return the cached result if still fresh, otherwise call `loader`, cache
   * its result (levels AND source together — see `ModelListCache.get`'s doc
   * for why splitting a list from its provenance is never safe) for
   * `ttlMs`, and return it. Concurrent callers during a load share the
   * single in-flight promise.
   */
  get(loader: () => Promise<EffortListResult>): Promise<EffortListResult>;
  /** Drop any cached value so the next `get` reloads. */
  clear(): void;
}

/** Create an {@link EffortListCache} with a `ttlMs` freshness window (default 60s). */
export function createEffortListCache(ttlMs = 60_000): EffortListCache {
  let value: EffortListResult | undefined;
  let expiresAt = 0;
  let inflight: Promise<EffortListResult> | undefined;

  return {
    async get(loader: () => Promise<EffortListResult>): Promise<EffortListResult> {
      const now = Date.now();
      if (value !== undefined && now < expiresAt) return value;
      if (inflight) return inflight;
      inflight = (async () => {
        try {
          const result = await loader();
          value = result;
          expiresAt = Date.now() + ttlMs;
          return result;
        } finally {
          inflight = undefined;
        }
      })();
      return inflight;
    },
    clear(): void {
      value = undefined;
      expiresAt = 0;
    },
  };
}
