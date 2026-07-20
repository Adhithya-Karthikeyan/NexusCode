/**
 * Prompt prefix-cache helpers (system-spec §17 + §3 cache invariant).
 *
 * Provider prompt-caches (Anthropic's `cache_control`, OpenAI/DeepSeek automatic
 * prefix caching) only pay off when the *front* of the prompt is byte-identical
 * turn-to-turn. The Context Engine already guarantees this: STATIC lanes are
 * serialized first, without per-request timestamps, and trimming only ever
 * removes from the VOLATILE tail. This module makes that guarantee usable:
 *
 *   - {@link PREFIX_STABILITY_CONTRACT} states the invariant the engine must keep.
 *   - {@link prefixCacheKey} derives a stable id for a rendered static prefix.
 *   - {@link buildPrefixCachePlan} bundles the key + token/breakpoint info.
 *   - {@link assertStablePrefix} verifies two renders share a byte-identical
 *     prefix (a guardrail for tests and for the engine's own self-checks).
 *   - {@link toAnthropicSystem} injects `cache_control` onto the stable prefix so
 *     Anthropic writes/reads a prompt cache over it.
 */

import { createHash } from "node:crypto";

/**
 * The contract the Context Engine must uphold for prompt-prefix caching to hit.
 * Exposed as data so tests and the engine can assert against it, and so the
 * ordering rule ("static lanes first, in a fixed order") is a shared constant
 * rather than tribal knowledge.
 */
export const PREFIX_STABILITY_CONTRACT = {
  /** STATIC lanes serialize into the prefix ahead of any VOLATILE content. */
  staticFirst: true,
  /** The prefix contains no per-request timestamps / nonces / volatile ids. */
  noVolatileTokensInPrefix: true,
  /** Compaction removes only from the volatile tail, never the static prefix. */
  trimTailOnly: true,
  /** Anthropic honours at most this many `cache_control` breakpoints. */
  maxBreakpoints: 4,
} as const;

/** SHA-256 hex id of a rendered static prefix (the cache-affinity fingerprint). */
export function prefixCacheKey(system: string): string {
  return createHash("sha256").update(system).digest("hex");
}

/** A plan describing how a static prefix caches. */
export interface PrefixCachePlan {
  /** Stable id of the prefix; identical static context → identical key. */
  key: string;
  /** The rendered prefix string. */
  system: string;
  /** Cache-breakpoint token offsets over the static lanes (engine-provided). */
  breakpoints: number[];
  /** Always `true` — asserts the prefix was produced under the stability contract. */
  stable: true;
}

/**
 * Build a {@link PrefixCachePlan} from a rendered static prefix and the engine's
 * breakpoint token-offsets (`ContextReport.breakpoints.map(b => b.tokenOffset)`).
 */
export function buildPrefixCachePlan(system: string, breakpointOffsets: number[] = []): PrefixCachePlan {
  return {
    key: prefixCacheKey(system),
    system,
    breakpoints: [...breakpointOffsets],
    stable: true,
  };
}

/**
 * Assert two renders of the same static context share a byte-identical prefix.
 * Returns the shared-prefix length and whether it spans the whole of `a`
 * (the expected outcome for identical static context).
 */
export function assertStablePrefix(a: string, b: string): { sharedPrefixLength: number; fullyStable: boolean } {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return { sharedPrefixLength: i, fullyStable: i === a.length && a.length === b.length };
}

/** Anthropic ephemeral cache marker. */
export interface AnthropicCacheControl {
  type: "ephemeral";
}

/** An Anthropic-shaped system block, optionally marked as a cache breakpoint. */
export interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface ToAnthropicSystemOptions {
  /** Max cache breakpoints to place (Anthropic cap is 4). Default 1. */
  maxBreakpoints?: number;
}

/**
 * Turn a stable prefix into Anthropic `system` blocks with `cache_control` on the
 * cacheable boundaries. Pass a single string to cache the whole prefix as one
 * block, or an ordered array of prefix segments (e.g. one per static lane) to
 * place up to `maxBreakpoints` cache markers on the *trailing* segments — each
 * marked block caches everything up to and including it.
 *
 * The result is meant for a request's `providerExtensions` (the Anthropic
 * adapter's frozen `system: string` field is left untouched; this is additive).
 */
export function toAnthropicSystem(
  prefix: string | string[],
  opts: ToAnthropicSystemOptions = {},
): AnthropicSystemBlock[] {
  const cap = Math.max(0, Math.min(opts.maxBreakpoints ?? 1, PREFIX_STABILITY_CONTRACT.maxBreakpoints));
  const segments = (Array.isArray(prefix) ? prefix : [prefix]).filter((s) => s.length > 0);
  if (segments.length === 0) return [];

  const marked = new Set<number>();
  // Mark the last `cap` segment boundaries — the deepest cache prefix first.
  for (let n = 0; n < cap && n < segments.length; n++) {
    marked.add(segments.length - 1 - n);
  }

  return segments.map((text, i) =>
    marked.has(i)
      ? { type: "text" as const, text, cache_control: { type: "ephemeral" as const } }
      : { type: "text" as const, text },
  );
}
