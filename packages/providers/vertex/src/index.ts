/**
 * @nexuscode/provider-vertex — a native {@link ProviderAdapter} over Google
 * Vertex AI, using `@google/genai` in Vertex mode (`vertexai: true`).
 *
 * Vertex speaks the same generateContent(Stream) protocol as the Gemini
 * Developer API, so this adapter reuses the pure request/stream translators from
 * `@nexuscode/provider-gemini` and differs only in identity and auth: Vertex
 * authenticates through Google Cloud Application Default Credentials (ADC) —
 * `GOOGLE_APPLICATION_CREDENTIALS`, `gcloud` login, or the workload's attached
 * service account / metadata server — rather than an API key.
 *
 * Construction is fully lazy: no client is built and no network is touched until
 * the first `stream`/`chat` call, so importing and constructing the adapter (and
 * probing its capabilities) is offline and side-effect free.
 */

import { GoogleGenAI } from "@google/genai";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import type {
  CallContext,
  ChatResult,
  HealthStatus,
  ProviderAdapter,
  TransportKind,
} from "@nexuscode/core";
import {
  toGeminiRequest,
  mapGeminiChunk,
  mapError,
  listGeminiModels,
  DEFAULT_GEMINI_MODELS,
  type GeminiChunkLike,
  type GeminiClientLike,
  type GeminiConfig,
} from "@nexuscode/provider-gemini";
import { createModelListCache } from "@nexuscode/shared";
import type {
  Capabilities,
  ChatRequest,
  ContentBlock,
  FinishReason,
  Message,
  ModelInfo,
  StreamChunk,
  Usage,
} from "@nexuscode/shared";
import { AdapterError } from "@nexuscode/shared";

const PROVIDER_ID = "vertex";

/** Static configuration for {@link createVertexAdapter}. */
export interface VertexConfig {
  /** Logical model id → native Vertex model id (e.g. `"gemini"` → `"gemini-2.0-flash"`). */
  modelMap: Record<string, string>;
  /** GCP project id. Falls back to ADC/`GOOGLE_CLOUD_PROJECT` resolution when omitted. */
  project?: string;
  /** Vertex location/region, e.g. `"us-central1"`. */
  location?: string;
  /** Pin an API version. */
  apiVersion?: string;
  /** Default `maxOutputTokens` when a request omits one. Default `4096`. */
  defaultMaxTokens?: number;
  /** Default thinking budget (tokens) when reasoning is enabled without a budget. Default `8000`. */
  defaultThinkingBudget?: number;
  /**
   * Test/di seam: build the client. When omitted, a real {@link GoogleGenAI}
   * client (Vertex mode, ADC auth) is created lazily on first use.
   */
  createClient?: () => GeminiClientLike;
}

/** Reproject a {@link VertexConfig} onto the shared {@link GeminiConfig} shape. */
function asGeminiConfig(cfg: VertexConfig): GeminiConfig {
  const g: GeminiConfig = { modelMap: cfg.modelMap, vertex: true };
  if (cfg.project !== undefined) g.project = cfg.project;
  if (cfg.location !== undefined) g.location = cfg.location;
  if (cfg.apiVersion !== undefined) g.apiVersion = cfg.apiVersion;
  if (cfg.defaultMaxTokens !== undefined) g.defaultMaxTokens = cfg.defaultMaxTokens;
  if (cfg.defaultThinkingBudget !== undefined) g.defaultThinkingBudget = cfg.defaultThinkingBudget;
  return g;
}

/** Build the native `generateContentStream` params from a canonical {@link ChatRequest}. */
export function toVertexRequest(cfg: VertexConfig, req: ChatRequest): GenerateContentParameters {
  return toGeminiRequest(asGeminiConfig(cfg), req);
}

/** Map one native Vertex stream chunk to canonical {@link StreamChunk}s (pure). */
export function mapVertexChunk(chunk: GeminiChunkLike, runId: string): StreamChunk[] {
  return mapGeminiChunk(chunk, runId);
}

export { mapError };
export type { GeminiChunkLike as VertexChunkLike };

function mapFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
      return "content_filter";
    default:
      return "stop";
  }
}

function buildModelInfos(modelMap: Record<string, string>): ModelInfo[] {
  const byNative = new Map<string, string[]>();
  for (const [alias, native] of Object.entries(modelMap)) {
    const list = byNative.get(native) ?? [];
    if (alias !== native) list.push(alias);
    byNative.set(native, list);
  }
  const infos: ModelInfo[] = [];
  for (const [native, aliases] of byNative) {
    const info: ModelInfo = { id: native, modalities: ["text", "image", "audio"] };
    if (aliases.length > 0) info.aliases = aliases;
    infos.push(info);
  }
  return infos;
}

/**
 * Create the native Vertex AI {@link ProviderAdapter}. The SDK client is built
 * once, lazily, on first use; credentials resolve through Google Cloud ADC at
 * request time (no key is read here).
 */
export function createVertexAdapter(cfg: VertexConfig): ProviderAdapter {
  const transport: TransportKind = "http-sdk";
  let client: GeminiClientLike | undefined;
  const modelCache = createModelListCache();

  const getClient = (): GeminiClientLike => {
    if (client) return client;
    if (cfg.createClient) {
      client = cfg.createClient();
    } else {
      const opts: ConstructorParameters<typeof GoogleGenAI>[0] = { vertexai: true };
      if (cfg.project !== undefined) opts.project = cfg.project;
      if (cfg.location !== undefined) opts.location = cfg.location;
      if (cfg.apiVersion !== undefined) opts.apiVersion = cfg.apiVersion;
      client = new GoogleGenAI(opts) as unknown as GeminiClientLike;
    }
    return client;
  };

  const capabilities = async (): Promise<Capabilities> => ({
    models: buildModelInfos(cfg.modelMap),
    streaming: true,
    tools: true,
    parallelToolCalls: true,
    vision: true,
    structuredOutput: true,
    reasoning: true,
    systemPrompt: true,
    fileEdit: false,
    shellExec: false,
    git: false,
    approvalGate: false,
    mcp: false,
    cancel: "abort-signal",
  });

  async function* stream(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamChunk> {
    const runId = ctx.runId;
    const nativeModel = cfg.modelMap[req.model] ?? req.model;

    yield { type: "run-start", runId, adapterId: PROVIDER_ID, model: nativeModel, ts: Date.now() };

    if (ctx.signal.aborted) {
      const error = new AdapterError("cancelled", "aborted", { providerId: PROVIDER_ID });
      yield { type: "error", runId, error, retryable: error.retryable };
      return;
    }

    let iterator: AsyncGenerator<GenerateContentResponse>;
    try {
      iterator = await getClient().models.generateContentStream(toVertexRequest(cfg, req));
    } catch (e) {
      const error = ctx.signal.aborted
        ? new AdapterError("cancelled", "aborted", { providerId: PROVIDER_ID })
        : mapError(e);
      yield { type: "error", runId, error, retryable: error.retryable };
      return;
    }

    const answer: string[] = [];
    const reasoning: string[] = [];
    const toolBlocks: Array<Extract<ContentBlock, { type: "tool_use" }>> = [];
    const toolNames = new Map<string, string>();
    let usage: Usage | undefined;
    let finishReason: FinishReason = "stop";

    try {
      for await (const chunk of iterator) {
        if (ctx.signal.aborted) {
          const error = new AdapterError("cancelled", "aborted", { providerId: PROVIDER_ID });
          yield { type: "error", runId, error, retryable: error.retryable };
          return;
        }
        const view = chunk as unknown as GeminiChunkLike;
        const fr = view.candidates?.[0]?.finishReason;
        if (fr) finishReason = mapFinish(fr);
        for (const mapped of mapVertexChunk(view, runId)) {
          if (mapped.type === "text-delta") answer.push(mapped.text);
          else if (mapped.type === "reasoning-delta") reasoning.push(mapped.text);
          else if (mapped.type === "tool-call-start") toolNames.set(mapped.id, mapped.name);
          else if (mapped.type === "tool-call-end") {
            toolBlocks.push({ type: "tool_use", id: mapped.id, name: toolNames.get(mapped.id) ?? "", input: mapped.input });
          } else if (mapped.type === "usage") {
            usage = { inputTokens: mapped.usage.inputTokens ?? 0, outputTokens: mapped.usage.outputTokens ?? 0, ...mapped.usage };
          }
          yield mapped;
        }
      }

      const content: ContentBlock[] = [];
      if (reasoning.length) content.push({ type: "thinking", text: reasoning.join("") });
      if (answer.length) content.push({ type: "text", text: answer.join("") });
      for (const tb of toolBlocks) content.push(tb);
      if (toolBlocks.length && finishReason === "stop") finishReason = "tool_use";

      const message: Message = { role: "assistant", content };
      const endChunk: Extract<StreamChunk, { type: "run-end" }> = {
        type: "run-end",
        runId,
        finishReason,
        message,
        ts: Date.now(),
      };
      if (usage) endChunk.usage = usage;
      yield endChunk;
    } catch (e) {
      const error = ctx.signal.aborted
        ? new AdapterError("cancelled", "aborted", { providerId: PROVIDER_ID })
        : mapError(e);
      yield { type: "error", runId, error, retryable: error.retryable };
    }
  }

  async function chat(req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
    let message: Message | undefined;
    let usage: Usage | undefined;
    let finishReason: FinishReason = "stop";

    for await (const chunk of stream(req, ctx)) {
      if (chunk.type === "run-end") {
        message = chunk.message;
        usage = chunk.usage;
        finishReason = chunk.finishReason;
      } else if (chunk.type === "error") {
        throw chunk.error;
      }
    }

    if (!message) {
      throw new AdapterError("empty_output", "Vertex adapter produced no output.", {
        providerId: PROVIDER_ID,
      });
    }

    const result: ChatResult = { message, finishReason };
    if (usage) result.usage = usage;
    return result;
  }

  const health = async (ctx: CallContext): Promise<HealthStatus> => {
    try {
      getClient();
    } catch (e) {
      const err = mapError(e);
      return { ok: false, detail: `${err.code}: ${err.message}` };
    }
    if (ctx.signal.aborted) return { ok: false, detail: "aborted" };
    return { ok: true, detail: "Vertex AI client ready (GCP ADC)" };
  };

  const listModels = (ctx?: CallContext): Promise<ModelInfo[]> => {
    const curated = buildModelInfos(cfg.modelMap);
    const fallback = curated.length > 0 ? curated : DEFAULT_GEMINI_MODELS;
    return modelCache.get(() => listGeminiModels(getClient, fallback, ctx?.signal));
  };

  const dispose = async (): Promise<void> => {
    client = undefined;
  };

  return {
    id: PROVIDER_ID,
    label: "Google Vertex AI",
    transport,
    capabilities,
    chat,
    stream,
    listModels,
    health,
    dispose,
  };
}
