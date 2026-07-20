/**
 * ResponseCache — returns a previously-computed model response for an *identical*
 * request (system-spec §17: response cache). This is the CAG (cache-augmented
 * generation) hot path: a deterministic request signature (model + messages +
 * system + tools + sampling params) hashes to a key; a hit replays the stored
 * response and books the input+output tokens (and USD, via the model's pricing)
 * as *saved*.
 *
 * Note: only cache requests you expect to be deterministic (temperature 0 or a
 * fixed seed). The cache never inspects sampling semantics — that policy is the
 * caller's, expressed by choosing whether to consult the cache.
 */

import type { ChatRequest, Message, Pricing, ToolChoice, ToolDef, Usage } from "@nexuscode/shared";
import { hashKey } from "../keys.js";
import { CacheAccounting } from "../accounting.js";
import type { CacheBackend, CacheStats } from "../types.js";

/** The subset of a request that determines its output identity. */
export interface ResponseSignature {
  model: string;
  messages: Message[];
  system?: string;
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: unknown;
}

/** A cached model result. */
export interface CachedResponse {
  /** Concatenated assistant text. */
  text: string;
  /** Token usage of the original (uncached) call — the basis for savings. */
  usage: Usage;
  /** Logical model id that produced it. */
  model: string;
  /** Optional finish reason / stop reason passthrough. */
  finishReason?: string;
  /** Optional structured/tool output passthrough. */
  raw?: unknown;
}

export interface ResponseCacheOptions {
  backend: CacheBackend<CachedResponse>;
  /** TTL (ms) for response entries; omit to use the backend default. */
  ttlMs?: number;
  /**
   * Pricing per logical model id, used to convert saved tokens into saved USD.
   * When absent (or a model is missing), savings still accrue in tokens.
   */
  pricing?: Record<string, Pricing>;
}

/** Reduce a full {@link ChatRequest} to the output-determining signature. */
export function signatureOf(req: ChatRequest): ResponseSignature {
  return {
    model: req.model,
    messages: req.messages,
    ...(req.system !== undefined ? { system: req.system } : {}),
    ...(req.tools !== undefined ? { tools: req.tools } : {}),
    ...(req.toolChoice !== undefined ? { toolChoice: req.toolChoice } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
    ...(req.responseFormat !== undefined ? { responseFormat: req.responseFormat } : {}),
  };
}

export class ResponseCache {
  private readonly backend: CacheBackend<CachedResponse>;
  private readonly ttlMs: number | undefined;
  private readonly pricing: Record<string, Pricing> | undefined;
  private readonly accounting = new CacheAccounting();

  constructor(opts: ResponseCacheOptions) {
    this.backend = opts.backend;
    this.ttlMs = opts.ttlMs;
    this.pricing = opts.pricing;
  }

  /** Deterministic key for a request signature. */
  key(sig: ResponseSignature): string {
    return hashKey("response", sig);
  }

  /**
   * Return a cached response for an identical request, booking the saved
   * tokens/cost; `undefined` on miss. Accepts either a full {@link ChatRequest}
   * or a pre-reduced {@link ResponseSignature} (the request is a structural
   * superset, so both normalize through {@link signatureOf}).
   */
  async get(reqOrSig: ChatRequest | ResponseSignature): Promise<CachedResponse | undefined> {
    const sig = signatureOf(reqOrSig as ChatRequest);
    const value = await this.backend.get(this.key(sig));
    if (value) {
      const pricing = this.pricing?.[value.model];
      this.accounting.recordHit(
        { inputTokens: value.usage.inputTokens, outputTokens: value.usage.outputTokens },
        pricing,
      );
    } else {
      this.accounting.recordMiss();
    }
    return value;
  }

  /** Store a response under its request signature. */
  async set(reqOrSig: ChatRequest | ResponseSignature, response: CachedResponse): Promise<void> {
    const sig = signatureOf(reqOrSig as ChatRequest);
    await this.backend.set(this.key(sig), response, {
      ...(this.ttlMs !== undefined ? { ttlMs: this.ttlMs } : {}),
    });
    this.accounting.recordWrite();
  }

  async clear(): Promise<void> {
    await this.backend.clear();
    this.accounting.reset();
  }

  async stats(): Promise<CacheStats> {
    return this.accounting.snapshot(this.backend.name, this.backend.metrics(), await this.backend.size());
  }
}
