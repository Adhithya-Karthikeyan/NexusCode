/**
 * Shared keep-alive HTTP connection pool (system-spec §23: connection pooling).
 *
 * Every HTTP-based provider adapter (OpenAI-compat, Anthropic, …) reuses ONE
 * process-wide keep-alive `http.Agent` / `https.Agent` rather than letting each
 * SDK client open its own short-lived sockets. With `keepAlive: true` the TCP +
 * TLS handshake is paid once and the socket is returned to a pool for the next
 * request, so a burst of calls to the same host reuses the same connection
 * instead of re-dialing every time — the dominant latency win for chatty agent
 * loops. The pool size (`maxSockets`) is configurable and defaults conservatively.
 *
 * Two singletons are kept (one per scheme) because a Node `Agent` is
 * scheme-specific: an `https.Agent` cannot serve a plain-`http` local backend
 * (e.g. Ollama on `http://localhost:11434`) and vice-versa. {@link sharedAgentFor}
 * picks the right one from a base URL so an adapter never has to care.
 *
 * Pure and offline: constructing an Agent opens no socket — the pool is
 * populated lazily by the first real request the SDK makes.
 */

import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";

/** Tuning for the shared keep-alive agents. */
export interface HttpPoolOptions {
  /**
   * Maximum concurrent sockets per host (the pool size). Bounds fan-out so a
   * parallel-tool storm can't exhaust file descriptors. Default 64.
   */
  maxSockets?: number;
  /** Maximum idle sockets kept warm per host for reuse. Default 16. */
  maxFreeSockets?: number;
  /** How long (ms) an idle keep-alive socket lingers before TCP keep-alive probes. Default 1000. */
  keepAliveMsecs?: number;
}

/** Default pool size (sockets per host) when none is configured. */
export const DEFAULT_MAX_SOCKETS = 64;
/** Default number of idle sockets kept warm per host. */
export const DEFAULT_MAX_FREE_SOCKETS = 16;
/** Default keep-alive probe delay (ms). */
export const DEFAULT_KEEP_ALIVE_MSECS = 1000;

interface ResolvedPoolOptions {
  maxSockets: number;
  maxFreeSockets: number;
  keepAliveMsecs: number;
}

let current: ResolvedPoolOptions = {
  maxSockets: DEFAULT_MAX_SOCKETS,
  maxFreeSockets: DEFAULT_MAX_FREE_SOCKETS,
  keepAliveMsecs: DEFAULT_KEEP_ALIVE_MSECS,
};

let httpsSingleton: HttpsAgent | undefined;
let httpSingleton: HttpAgent | undefined;

function resolve(opts: HttpPoolOptions | undefined, base: ResolvedPoolOptions): ResolvedPoolOptions {
  const maxSockets = opts?.maxSockets;
  const maxFreeSockets = opts?.maxFreeSockets;
  const keepAliveMsecs = opts?.keepAliveMsecs;
  return {
    maxSockets: maxSockets && maxSockets > 0 ? maxSockets : base.maxSockets,
    maxFreeSockets: maxFreeSockets && maxFreeSockets > 0 ? maxFreeSockets : base.maxFreeSockets,
    keepAliveMsecs: keepAliveMsecs && keepAliveMsecs > 0 ? keepAliveMsecs : base.keepAliveMsecs,
  };
}

/**
 * Set the process-wide pool tuning. Any change to the resolved options discards
 * the existing singletons (their idle sockets are destroyed) so the next
 * {@link sharedHttpsAgent}/{@link sharedHttpAgent} call builds a fresh agent with
 * the new settings. Merges over the current config, so a partial update keeps the
 * other fields.
 */
export function configureHttpPool(opts: HttpPoolOptions): void {
  const next = resolve(opts, current);
  const changed =
    next.maxSockets !== current.maxSockets ||
    next.maxFreeSockets !== current.maxFreeSockets ||
    next.keepAliveMsecs !== current.keepAliveMsecs;
  current = next;
  if (changed) resetHttpPool();
}

/** The current resolved pool tuning (defensive copy). */
export function httpPoolOptions(): ResolvedPoolOptions {
  return { ...current };
}

/** The one process-wide keep-alive `https.Agent`, built on first use. */
export function sharedHttpsAgent(): HttpsAgent {
  if (!httpsSingleton) {
    httpsSingleton = new HttpsAgent({
      keepAlive: true,
      maxSockets: current.maxSockets,
      maxFreeSockets: current.maxFreeSockets,
      keepAliveMsecs: current.keepAliveMsecs,
    });
  }
  return httpsSingleton;
}

/** The one process-wide keep-alive `http.Agent`, built on first use. */
export function sharedHttpAgent(): HttpAgent {
  if (!httpSingleton) {
    httpSingleton = new HttpAgent({
      keepAlive: true,
      maxSockets: current.maxSockets,
      maxFreeSockets: current.maxFreeSockets,
      keepAliveMsecs: current.keepAliveMsecs,
    });
  }
  return httpSingleton;
}

/**
 * The shared keep-alive agent appropriate for `baseURL`'s scheme. A `http://`
 * URL (e.g. a local Ollama/LM Studio endpoint) gets the `http.Agent`; anything
 * else — including an absent/undefined URL (SDK defaults to its `https` host) —
 * gets the `https.Agent`. The returned agent is a stable singleton, so repeated
 * calls (across requests and across adapters) share one socket pool.
 */
export function sharedAgentFor(baseURL?: string): HttpAgent | HttpsAgent {
  if (baseURL) {
    try {
      if (new URL(baseURL).protocol === "http:") return sharedHttpAgent();
    } catch {
      // Unparseable URL → fall through to the https agent (SDK will reject a bad URL itself).
    }
  }
  return sharedHttpsAgent();
}

/**
 * Destroy and drop the shared agents (closing their idle keep-alive sockets).
 * The next accessor rebuilds them from the current tuning. Intended for tests
 * and clean shutdown; production code rarely needs it.
 */
export function resetHttpPool(): void {
  httpsSingleton?.destroy();
  httpSingleton?.destroy();
  httpsSingleton = undefined;
  httpSingleton = undefined;
}
