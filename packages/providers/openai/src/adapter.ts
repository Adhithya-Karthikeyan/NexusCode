/**
 * Adapter factories.
 *
 *  - {@link createOpenAICompatAdapter} — the generic OpenAI-compatible transport.
 *    Any backend that speaks `/v1/chat/completions` (Grok, Ollama, Groq,
 *    DeepSeek, Mistral, …) is a config object, not a package.
 *  - {@link createOpenAIAdapter} — the native `openai` adapter (id "openai"):
 *    the same transport pre-configured with OpenAI's catalog and richer caps
 *    (vision, reasoning effort).
 *  - {@link grokCompatConfig} / {@link createGrokAdapter} — a ready xAI Grok
 *    config over the compat transport.
 *
 * No network I/O happens at construction or import time; clients are built
 * lazily on the first `chat`/`stream`/`health` call.
 */

import { createHash } from "node:crypto";
import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import OpenAI from "openai";
import { sharedAgentFor, createModelListCache, type ModelListCache } from "@nexuscode/shared";
import {
  AdapterError,
  type Capabilities,
  type CallContext,
  type ChatRequest,
  type ChatResult,
  type FinishReason,
  type HealthStatus,
  type Message,
  type ModelInfo,
  type ProviderAdapter,
  type StreamChunk,
  type TransportKind,
  type Usage,
} from "@nexuscode/core";
import { buildStreamingBody, type BodyOptions } from "./convert.js";
import { mapOpenAIError } from "./errors.js";
import { streamChatCompletion, type StreamOptions } from "./stream.js";

/** A credential provider: a literal key, or a (possibly async) resolver. */
export type ApiKeyProvider = string | (() => string | Promise<string>);

export interface OpenAICompatConfig {
  /** Adapter id, e.g. "grok" | "ollama" | "openai". */
  id: string;
  /** Human label for the TUI (defaults to a title-cased id). */
  label?: string;
  /** Backend base URL. Omit for OpenAI's default endpoint. */
  baseURL?: string;
  /** logical model id → native model id. Identity mapping when omitted. */
  modelMap?: Record<string, string>;
  /**
   * Fallback credential when the call context carries none. `ctx.credential`
   * (resolved by the core secret chain) always wins over this.
   */
  apiKey?: ApiKeyProvider;
  /** Whether a credential is required. Default true; Ollama sets it false. */
  requiresAuth?: boolean;
  /** Static model catalog surfaced through `capabilities()`. */
  models?: ModelInfo[];
  /** Capability overrides merged over the compat defaults. */
  capabilities?: Partial<Capabilities>;
  /** Extra static headers (never secrets). */
  defaultHeaders?: Record<string, string>;
  /** Force `usage.costUsd = 0` (local/free backends like Ollama). */
  zeroCost?: boolean;
  /** Request a trailing usage chunk (`stream_options.include_usage`). Default true. */
  includeUsage?: boolean;
  /** Emit `reasoning_effort` for o-series style models. Default false. */
  supportsReasoningEffort?: boolean;
  /**
   * Native embeddings model id. When set, the adapter exposes the optional
   * `embed()` method (over `/v1/embeddings`) and reports `capabilities().embeddings
   * = true`. Omit for backends without an embeddings endpoint.
   */
  embedModel?: string;
  /** Transport tag; defaults to "http-openai-compat" (native openai → "http-sdk"). */
  transport?: TransportKind;
  /**
   * Explicit keep-alive HTTP(S) agent for the SDK's socket pool (system-spec §23:
   * connection pooling). Omit to use the process-wide shared agent picked by the
   * backend's scheme ({@link sharedAgentFor}) so sockets are reused across calls
   * and across adapters; pass one only to isolate or tune a single provider
   * (or to inject a spy in tests).
   */
  httpAgent?: HttpAgent | HttpsAgent;
  /**
   * Custom client builder. When provided it replaces the default
   * `new OpenAI({...})` construction and receives the credential resolved by the
   * secret chain. Used by backends whose SDK client differs — e.g. Azure OpenAI
   * (`new AzureOpenAI({ endpoint, apiVersion, deployment, apiKey })`). The
   * returned client MUST be OpenAI-compatible (AzureOpenAI extends OpenAI) and
   * SHOULD set `maxRetries: 0` (retries are owned by core). Called lazily on the
   * first `chat`/`stream`/`health` — never at import or construction time.
   */
  createClient?: (args: {
    apiKey: string;
    baseURL?: string;
    defaultHeaders?: Record<string, string>;
  }) => OpenAI;
}

function titleCase(id: string): string {
  return id.length === 0 ? id : id[0]!.toUpperCase() + id.slice(1);
}

const COMPAT_CAP_DEFAULTS: Omit<Capabilities, "models"> = {
  streaming: true,
  tools: true,
  parallelToolCalls: true,
  vision: false,
  audio: false,
  embeddings: false,
  structuredOutput: true,
  reasoning: false,
  systemPrompt: true,
  fileEdit: false,
  shellExec: false,
  git: false,
  approvalGate: false,
  mcp: false,
  cancel: "abort-signal",
};

class OpenAICompatAdapter implements ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly transport: TransportKind;

  private readonly cfg: OpenAICompatConfig;
  private readonly caps: Capabilities;
  private readonly bodyBase: Omit<BodyOptions, "resolveModel">;
  private readonly streamOpts: StreamOptions;
  /**
   * Clients cached by a SHA-256 digest of the resolved credential (never the
   * plaintext key) so a repeated key reuses the socket pool without retaining
   * the secret as a live Map key.
   */
  private readonly clients = new Map<string, OpenAI>();

  /** Brief per-adapter cache for {@link listModels} (real `/models` discovery). */
  private readonly modelCache: ModelListCache = createModelListCache();

  /**
   * Native embeddings endpoint — present only when the config declares an
   * `embedModel`. Kept as an optional instance property (not an always-on class
   * method) so `typeof adapter.embed === "function"` is a truthful signal that the
   * backend actually supports embeddings.
   */
  readonly embed?: (texts: string[], ctx?: CallContext) => Promise<number[][]>;

  constructor(cfg: OpenAICompatConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.label = cfg.label ?? titleCase(cfg.id);
    this.transport = cfg.transport ?? "http-openai-compat";
    this.caps = {
      ...COMPAT_CAP_DEFAULTS,
      ...cfg.capabilities,
      models: cfg.models ?? cfg.capabilities?.models ?? [],
    };
    if (cfg.embedModel) this.caps.embeddings = true;
    this.bodyBase = {
      includeUsage: cfg.includeUsage ?? true,
      supportsReasoningEffort: cfg.supportsReasoningEffort ?? false,
    };
    this.streamOpts = cfg.zeroCost ? { zeroCost: true } : {};

    if (cfg.embedModel) {
      const model = cfg.embedModel;
      this.embed = async (texts: string[], ctx?: CallContext): Promise<number[][]> => {
        if (texts.length === 0) return [];
        const client = await this.clientFor(ctx);
        const opts = ctx?.signal ? { signal: ctx.signal } : undefined;
        const res = await client.embeddings.create({ model, input: texts }, opts);
        // Re-order by `index` so vectors align with the input array regardless of
        // any provider reordering, then strip to the raw number[] rows.
        return [...res.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
      };
    }
  }

  private resolveModel = (model: string): string => this.cfg.modelMap?.[model] ?? model;

  private async resolveKey(ctx?: CallContext): Promise<string> {
    const fromCtx = ctx?.credential?.value;
    if (fromCtx) return fromCtx;
    const { apiKey, requiresAuth = true } = this.cfg;
    if (typeof apiKey === "function") {
      const k = await apiKey();
      if (k) return k;
    } else if (typeof apiKey === "string" && apiKey) {
      return apiKey;
    }
    if (requiresAuth) {
      throw new AdapterError("auth", `no credential available for provider "${this.id}"`, {
        providerId: this.id,
        retryable: false,
      });
    }
    // Auth-less backend (Ollama): the SDK still needs a non-empty placeholder.
    return "no-key-required";
  }

  private async clientFor(ctx?: CallContext): Promise<OpenAI> {
    const key = await this.resolveKey(ctx);
    const cacheKey = createHash("sha256").update(key).digest("hex");
    const cached = this.clients.get(cacheKey);
    if (cached) return cached;
    let client: OpenAI;
    if (this.cfg.createClient) {
      const args: { apiKey: string; baseURL?: string; defaultHeaders?: Record<string, string> } = {
        apiKey: key,
      };
      if (this.cfg.baseURL) args.baseURL = this.cfg.baseURL;
      if (this.cfg.defaultHeaders) args.defaultHeaders = this.cfg.defaultHeaders;
      client = this.cfg.createClient(args);
    } else {
      const opts: ConstructorParameters<typeof OpenAI>[0] = { apiKey: key, maxRetries: 0 };
      if (this.cfg.baseURL) opts.baseURL = this.cfg.baseURL;
      if (this.cfg.defaultHeaders) opts.defaultHeaders = this.cfg.defaultHeaders;
      // Connection pooling (§23): reuse a process-wide keep-alive agent so the
      // TCP+TLS handshake is amortized and sockets are pooled across calls
      // instead of re-dialed each request. An explicit `httpAgent` override wins.
      opts.httpAgent = this.cfg.httpAgent ?? sharedAgentFor(this.cfg.baseURL);
      client = new OpenAI(opts);
    }
    this.clients.set(cacheKey, client);
    return client;
  }

  async capabilities(): Promise<Capabilities> {
    // Static + config-driven; no network probe at registration.
    return this.caps;
  }

  /** The curated static catalog this backend falls back to. */
  private curatedModels(): ModelInfo[] {
    return this.caps.models;
  }

  /**
   * Real model discovery for this provider: `GET {baseURL}/models` via the SDK
   * (which sends the resolved `Authorization` when a key is present), mapping
   * `data[].id`. Live ids are enriched with any metadata (contextWindow,
   * modalities, aliases) from the curated catalog when the ids match.
   *
   * Graceful degradation: a missing credential, an offline/unreachable backend,
   * or a backend with no `/models` endpoint all fall back to the curated static
   * catalog. Never throws. Result is cached briefly per adapter.
   */
  async listModels(ctx?: CallContext): Promise<ModelInfo[]> {
    return this.modelCache.get(async () => {
      try {
        const client = await this.clientFor(ctx);
        const opts = ctx?.signal ? { signal: ctx.signal } : undefined;
        const page = (await client.models.list(opts)) as unknown as {
          data?: Array<{ id?: unknown }>;
        };
        const curated = new Map(this.curatedModels().map((m) => [m.id, m]));
        const seen = new Set<string>();
        const out: ModelInfo[] = [];
        for (const row of page.data ?? []) {
          const id = typeof row.id === "string" ? row.id : "";
          if (!id || seen.has(id)) continue;
          seen.add(id);
          out.push(curated.get(id) ?? { id });
        }
        // An empty/parseless response is not a valid live catalog — fall back.
        return out.length > 0 ? out : this.curatedModels();
      } catch {
        return this.curatedModels();
      }
    });
  }

  async *stream(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamChunk> {
    let client: OpenAI;
    try {
      client = await this.clientFor(ctx);
    } catch (err) {
      const adapterError = mapOpenAIError(err, this.id);
      yield { type: "run-start", runId: ctx.runId, adapterId: this.id, model: this.resolveModel(req.model), ts: Date.now() };
      yield { type: "error", runId: ctx.runId, error: adapterError, retryable: adapterError.retryable };
      return;
    }
    const body = buildStreamingBody(req, { ...this.bodyBase, resolveModel: this.resolveModel });
    yield* streamChatCompletion(client, body, ctx, this.id, this.streamOpts);
  }

  async chat(req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
    let message: Message = { role: "assistant", content: [] };
    let usage: Usage | undefined;
    let finishReason: FinishReason = "stop";
    for await (const chunk of this.stream(req, ctx)) {
      if (chunk.type === "run-end") {
        message = chunk.message;
        usage = chunk.usage;
        finishReason = chunk.finishReason;
      } else if (chunk.type === "error") {
        throw chunk.error;
      }
    }
    const result: ChatResult = { message, finishReason };
    if (usage) result.usage = usage;
    return result;
  }

  async health(ctx: CallContext): Promise<HealthStatus> {
    try {
      const client = await this.clientFor(ctx);
      await client.models.list({ signal: ctx.signal });
      return { ok: true };
    } catch (err) {
      const adapterError = mapOpenAIError(err, this.id);
      return { ok: false, detail: `${adapterError.code}: ${adapterError.message}` };
    }
  }

  async dispose(): Promise<void> {
    this.clients.clear();
  }
}

/** Build a generic OpenAI-compatible adapter from a config object. */
export function createOpenAICompatAdapter(cfg: OpenAICompatConfig): ProviderAdapter {
  return new OpenAICompatAdapter(cfg);
}

// ── Native OpenAI ─────────────────────────────────────────────────────────────

/** A small, current default catalog for OpenAI. Pricing stays config-driven. */
export const DEFAULT_OPENAI_MODELS: ModelInfo[] = [
  { id: "gpt-4o", contextWindow: 128_000, maxOutput: 16_384, modalities: ["text", "image"] },
  { id: "gpt-4o-mini", contextWindow: 128_000, maxOutput: 16_384, modalities: ["text", "image"] },
  { id: "gpt-4.1", contextWindow: 1_047_576, maxOutput: 32_768, modalities: ["text", "image"] },
  { id: "gpt-4.1-mini", contextWindow: 1_047_576, maxOutput: 32_768, modalities: ["text", "image"] },
  { id: "o3", contextWindow: 200_000, maxOutput: 100_000, modalities: ["text", "image"] },
  { id: "o4-mini", contextWindow: 200_000, maxOutput: 100_000, modalities: ["text", "image"] },
];

export interface OpenAIAdapterOptions {
  apiKey?: ApiKeyProvider;
  baseURL?: string;
  modelMap?: Record<string, string>;
  models?: ModelInfo[];
  defaultHeaders?: Record<string, string>;
  /** Override the embeddings model (default `"text-embedding-3-small"`). */
  embedModel?: string;
}

/** OpenAI's current default embeddings model. Pricing stays config-driven. */
export const DEFAULT_OPENAI_EMBED_MODEL = "text-embedding-3-small";

/** The native OpenAI adapter (id "openai") over the Chat Completions transport. */
export function createOpenAIAdapter(opts: OpenAIAdapterOptions = {}): ProviderAdapter {
  const cfg: OpenAICompatConfig = {
    id: "openai",
    label: "OpenAI",
    transport: "http-sdk",
    models: opts.models ?? DEFAULT_OPENAI_MODELS,
    supportsReasoningEffort: true,
    // gpt-4o accepts image + audio input; the embeddings endpoint backs `embed()`.
    capabilities: { vision: true, audio: true, reasoning: true },
    embedModel: opts.embedModel ?? DEFAULT_OPENAI_EMBED_MODEL,
  };
  if (opts.apiKey !== undefined) cfg.apiKey = opts.apiKey;
  if (opts.baseURL !== undefined) cfg.baseURL = opts.baseURL;
  if (opts.modelMap !== undefined) cfg.modelMap = opts.modelMap;
  if (opts.defaultHeaders !== undefined) cfg.defaultHeaders = opts.defaultHeaders;
  return createOpenAICompatAdapter(cfg);
}

// ── xAI Grok (compat) ─────────────────────────────────────────────────────────

/** A current default Grok catalog. */
export const DEFAULT_GROK_MODELS: ModelInfo[] = [
  { id: "grok-4", contextWindow: 256_000, modalities: ["text", "image"] },
  { id: "grok-4-fast-reasoning", contextWindow: 2_000_000, modalities: ["text"] },
  { id: "grok-3", contextWindow: 131_072, modalities: ["text"] },
  { id: "grok-3-mini", contextWindow: 131_072, modalities: ["text"] },
];

export interface GrokConfigOptions {
  apiKey?: ApiKeyProvider;
  modelMap?: Record<string, string>;
  models?: ModelInfo[];
}

/** Ready xAI Grok config over the OpenAI-compatible transport. */
export function grokCompatConfig(opts: GrokConfigOptions = {}): OpenAICompatConfig {
  const cfg: OpenAICompatConfig = {
    id: "grok",
    label: "xAI Grok",
    baseURL: "https://api.x.ai/v1",
    models: opts.models ?? DEFAULT_GROK_MODELS,
    capabilities: { vision: true },
  };
  if (opts.apiKey !== undefined) cfg.apiKey = opts.apiKey;
  if (opts.modelMap !== undefined) cfg.modelMap = opts.modelMap;
  return cfg;
}

/** Convenience: a ready Grok adapter. */
export function createGrokAdapter(opts: GrokConfigOptions = {}): ProviderAdapter {
  return createOpenAICompatAdapter(grokCompatConfig(opts));
}
