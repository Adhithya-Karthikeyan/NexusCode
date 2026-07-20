/**
 * Cache-affinity routing hook (system-spec §17 + §2 routing).
 *
 * Provider prompt-caches are per-provider: a session that keeps landing on the
 * same provider keeps hitting a warm prefix cache, while bouncing between
 * providers pays the full prompt cost every turn. {@link SessionAffinity} records
 * which provider a session last used and {@link applyAffinity} *reorders* a
 * router's candidate list to prefer that provider — a soft pin.
 *
 * Crucially this only reorders; it never removes candidates, so live failover
 * still works: if the pinned provider is unhealthy the router simply falls
 * through to the next candidate, and the next successful run re-pins.
 */

import type { Clock } from "./types.js";

export interface SessionAffinityOptions {
  /**
   * How long a pin stays valid (ms). After this, the session is free to
   * re-optimize (e.g. a cheaper provider came back healthy). Omit = no expiry.
   */
  ttlMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: Clock;
}

interface Pin {
  providerId: string;
  at: number;
}

/** In-memory map of session → preferred provider, for prompt-cache stickiness. */
export class SessionAffinity {
  private readonly pins = new Map<string, Pin>();
  private readonly ttlMs: number | undefined;
  private readonly clock: Clock;

  constructor(opts: SessionAffinityOptions = {}) {
    this.ttlMs = opts.ttlMs;
    this.clock = opts.now ?? Date.now;
  }

  /** Explicitly pin a session to a provider. */
  pin(sessionId: string, providerId: string): void {
    this.pins.set(sessionId, { providerId, at: this.clock() });
  }

  /** Record the provider a session actually ran on (re-pins to it). */
  recordUse(sessionId: string, providerId: string): void {
    this.pin(sessionId, providerId);
  }

  /** The still-valid preferred provider for a session, or `undefined`. */
  preferred(sessionId: string): string | undefined {
    const pin = this.pins.get(sessionId);
    if (!pin) return undefined;
    if (this.ttlMs !== undefined && this.clock() - pin.at >= this.ttlMs) {
      this.pins.delete(sessionId);
      return undefined;
    }
    return pin.providerId;
  }

  /** Forget one session's pin, or all pins when called with no argument. */
  clear(sessionId?: string): void {
    if (sessionId === undefined) this.pins.clear();
    else this.pins.delete(sessionId);
  }
}

/**
 * Reorder router candidates to put the preferred provider's candidates first,
 * preserving the relative order of everything else. Returns a NEW array; the
 * input is untouched. When `preferred` is undefined or absent from the list, the
 * candidates are returned in their original order — so failover is never blocked.
 */
export function applyAffinity<T extends { providerId: string }>(
  candidates: readonly T[],
  preferred: string | undefined,
): T[] {
  if (!preferred) return [...candidates];
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const c of candidates) {
    if (c.providerId === preferred) pinned.push(c);
    else rest.push(c);
  }
  if (pinned.length === 0) return [...candidates];
  return [...pinned, ...rest];
}
