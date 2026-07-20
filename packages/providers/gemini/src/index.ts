/**
 * @nexuscode/provider-gemini — a native {@link ProviderAdapter} over the
 * official `@google/genai` SDK.
 *
 * Native transport (rather than the OpenAI-compat multiplexer) is used so the
 * adapter can expose Gemini-specific power end-to-end: multimodal (`vision`),
 * function-calling tools, and extended thinking / thought signatures
 * (`reasoning`) — all normalized into the canonical {@link StreamChunk} union
 * so the rest of NexusCode never sees a Gemini-shaped object.
 *
 * The same SDK serves both the Gemini Developer API (`GEMINI_API_KEY`) and
 * Vertex AI (`vertexai: true`, GCP Application Default Credentials). Construction
 * is fully lazy: no client is built and no network is touched until the first
 * `stream`/`chat` call, so importing and constructing the adapter — and probing
 * its capabilities — is offline and side-effect free.
 */

import { GoogleGenAI } from "@google/genai";
import type {
  Content,
  FunctionDeclaration,
  GenerateContentConfig,
  GenerateContentParameters,
  GenerateContentResponse,
  Part,
} from "@google/genai";
import type {
  CallContext,
  ChatResult,
  HealthStatus,
  ProviderAdapter,
  TransportKind,
} from "@nexuscode/core";
import type {
  Capabilities,
  ChatRequest,
  ContentBlock,
  FinishReason,
  Message,
  ModelInfo,
  StreamChunk,
  ToolDef,
  Usage,
} from "@nexuscode/shared";
import { AdapterError, createModelListCache } from "@nexuscode/shared";

const PROVIDER_ID = "gemini";

/** Default env var the lazy credential resolver reads. */
export const GEMINI_API_KEY_ENV = "GEMINI_API_KEY";

/**
 * A curated snapshot of current selectable Gemini models — the graceful fallback
 * for {@link ProviderAdapter.listModels} when `models.list` cannot be reached
 * (no key, offline, error). Ids only; pricing/context stay config-driven.
 */
export const DEFAULT_GEMINI_MODELS: ModelInfo[] = [
  { id: "gemini-2.5-pro", modalities: ["text", "image", "audio"] },
  { id: "gemini-2.5-flash", modalities: ["text", "image", "audio"] },
  { id: "gemini-2.0-flash", modalities: ["text", "image", "audio"] },
  { id: "gemini-2.0-flash-lite", modalities: ["text", "image", "audio"] },
];

/**
 * The narrow surface of `@google/genai` this adapter actually calls. Declaring
 * it as a seam (rather than depending on the concrete `GoogleGenAI` type at the
 * call sites) lets tests inject a fake client that yields canned chunks without
 * ever constructing the real SDK or touching the network.
 */
export interface GeminiClientLike {
  models: {
    generateContentStream(
      params: GenerateContentParameters,
    ): Promise<AsyncGenerator<GenerateContentResponse>>;
    /**
     * Optional model discovery (`ai.models.list()`). Present on the real SDK
     * client; declared optional so a minimal fake (stream-only) still satisfies
     * the seam. Yields models whose `name` is like `"models/gemini-2.0-flash"`.
     */
    list?(
      params?: unknown,
    ): Promise<AsyncIterable<{ name?: string }>> | AsyncIterable<{ name?: string }>;
  };
}

/** Static configuration for {@link createGeminiAdapter}. */
export interface GeminiConfig {
  /** Logical model id → native Gemini model id (e.g. `"flash"` → `"gemini-2.0-flash"`). */
  modelMap: Record<string, string>;
  /** Use Vertex AI (GCP ADC) instead of the Gemini Developer API. */
  vertex?: boolean;
  /** Vertex project id (vertex mode only). */
  project?: string;
  /** Vertex location, e.g. `"us-central1"` (vertex mode only). */
  location?: string;
  /** Pin an API version (e.g. `"v1"`). */
  apiVersion?: string;
  /** Default `maxOutputTokens` when a request omits one. Default `4096`. */
  defaultMaxTokens?: number;
  /** Default thinking budget (tokens) when reasoning is enabled without a budget. Default `8000`. */
  defaultThinkingBudget?: number;
  /**
   * Test/di seam: build the client. When omitted, a real {@link GoogleGenAI}
   * client is created lazily on first use from the resolved credential.
   */
  createClient?: (apiKey: string) => GeminiClientLike;
}

/** A credential resolver — invoked lazily so no key is read until first use. */
export type CredentialResolver = () => string | Promise<string>;

// ── Request translation ────────────────────────────────────────────────────────

/** Map one canonical content block to zero-or-more Gemini {@link Part}s. */
function mapContentBlock(b: ContentBlock): Part[] {
  switch (b.type) {
    case "text":
      return [{ text: b.text }];
    case "image": {
      if (typeof b.data === "string") {
        return [{ inlineData: { mimeType: b.mime, data: b.data } }];
      }
      // A URL reference (unsupported inline) degrades to a lossless text note.
      return [{ text: `[image: ${b.data.url}]` }];
    }
    case "tool_use":
      return [
        {
          functionCall: {
            id: b.id,
            name: b.name,
            args: (b.input ?? {}) as Record<string, unknown>,
          },
        },
      ];
    case "tool_result":
      return [
        {
          functionResponse: {
            id: b.toolCallId,
            name: b.toolCallId,
            response: { content: b.content.map(textFromBlock).join("") },
          },
        },
      ];
    case "thinking": {
      const part: Part = { text: b.text, thought: true };
      if (b.signature !== undefined) part.thoughtSignature = b.signature;
      return [part];
    }
    default:
      return [];
  }
}

function textFromBlock(b: ContentBlock): string {
  switch (b.type) {
    case "text":
    case "thinking":
      return b.text;
    case "tool_use":
      return `[tool_use ${b.name}]`;
    case "tool_result":
      return b.content.map(textFromBlock).join("");
    case "image":
      return typeof b.data === "string" ? "[image]" : `[image: ${b.data.url}]`;
    default:
      return "";
  }
}

/** Canonical messages → Gemini `Content[]`. `system` is hoisted; `tool` → `user`. */
export function mapMessages(messages: Message[]): Content[] {
  const out: Content[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // hoisted to `config.systemInstruction`
    const parts = m.content.flatMap(mapContentBlock);
    out.push({ role: m.role === "assistant" ? "model" : "user", parts });
  }
  return out;
}

function mapTools(tools: ToolDef[] | undefined): FunctionDeclaration[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => {
    const decl: FunctionDeclaration = { name: t.name };
    if (t.description !== undefined) decl.description = t.description;
    decl.parametersJsonSchema = t.parameters;
    return decl;
  });
}

/** Build the native `generateContentStream` params from a canonical {@link ChatRequest}. */
export function toGeminiRequest(
  cfg: GeminiConfig,
  req: ChatRequest,
): GenerateContentParameters {
  const nativeModel = cfg.modelMap[req.model] ?? req.model;
  const dropTools = req.toolChoice === "none";

  const config: GenerateContentConfig = {};
  if (req.system !== undefined) config.systemInstruction = req.system;
  if (req.temperature !== undefined) config.temperature = req.temperature;
  config.maxOutputTokens = req.maxTokens ?? cfg.defaultMaxTokens ?? 4096;

  const decls = dropTools ? undefined : mapTools(req.tools);
  if (decls) config.tools = [{ functionDeclarations: decls }];

  if (req.reasoning?.enabled) {
    config.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: req.reasoning.budgetTokens ?? cfg.defaultThinkingBudget ?? 8000,
    };
  }

  // Provider-specific extras are merged onto config, never dropped.
  Object.assign(config, req.providerExtensions ?? {});

  return { model: nativeModel, contents: mapMessages(req.messages), config };
}

// ── Response translation ────────────────────────────────────────────────────────

/** A single native stream chunk, in the structural shape this adapter reads. */
export interface GeminiChunkLike {
  candidates?: Array<{
    content?: { parts?: Part[]; role?: string };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    totalTokenCount?: number;
  };
}

function mapFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case "MAX_TOKENS":
      return "length";
    case "SAFETY":
    case "RECITATION":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
      return "content_filter";
    case "STOP":
    case undefined:
      return "stop";
    default:
      return "stop";
  }
}

function mapUsage(u: GeminiChunkLike["usageMetadata"]): Usage {
  const usage: Usage = {
    inputTokens: u?.promptTokenCount ?? 0,
    outputTokens: u?.candidatesTokenCount ?? 0,
  };
  if (u?.thoughtsTokenCount != null) usage.reasoningTokens = u.thoughtsTokenCount;
  if (u?.cachedContentTokenCount != null) usage.cacheReadTokens = u.cachedContentTokenCount;
  return usage;
}

/**
 * Map one native Gemini stream chunk to canonical {@link StreamChunk}s (pure).
 * Gemini streams whole function calls (not JSON deltas), so each `functionCall`
 * part becomes a matched `tool-call-start` + `tool-call-end` pair.
 */
export function mapGeminiChunk(chunk: GeminiChunkLike, runId: string): StreamChunk[] {
  const out: StreamChunk[] = [];
  const parts = chunk.candidates?.[0]?.content?.parts ?? [];
  for (const p of parts) {
    if (p.functionCall) {
      const id = p.functionCall.id ?? p.functionCall.name ?? "call";
      out.push({ type: "tool-call-start", runId, id, name: p.functionCall.name ?? "", raw: p });
      out.push({ type: "tool-call-end", runId, id, input: p.functionCall.args ?? {}, raw: p });
    } else if (typeof p.text === "string" && p.text.length > 0) {
      if (p.thought) {
        out.push({ type: "reasoning-delta", runId, text: p.text, raw: p });
      } else {
        out.push({ type: "text-delta", runId, text: p.text, channel: "answer", raw: p });
      }
    }
  }
  if (chunk.usageMetadata) {
    out.push({ type: "usage", runId, usage: mapUsage(chunk.usageMetadata), raw: chunk.usageMetadata });
  }
  return out;
}

// ── Error mapping ────────────────────────────────────────────────────────────────

function redactSecrets(msg: string): string {
  return msg
    .replace(/\b(sk|xai|gsk|nvapi|or|AIza)-?[A-Za-z0-9_-]{6,}\b/gi, "***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***")
    .replace(/key=[A-Za-z0-9_-]+/gi, "key=***");
}

interface HttpishError {
  status?: number;
  code?: number;
  message?: string;
}

/** Map any SDK / transport failure onto the normalized {@link AdapterError}. */
export function mapError(e: unknown): AdapterError {
  if (e instanceof AdapterError) return e; // already normalized (e.g. missing key)
  const err = e as HttpishError;
  const status = typeof err?.status === "number" ? err.status : err?.code;
  const rawMsg = e instanceof Error ? e.message : typeof err?.message === "string" ? err.message : "unknown Gemini transport error";
  const msg = redactSecrets(rawMsg);
  if (status === 401 || status === 403) {
    return new AdapterError("auth", msg, { httpStatus: status, providerId: PROVIDER_ID, cause: e });
  }
  if (status === 429) {
    return new AdapterError("rate_limit", msg, { httpStatus: status, providerId: PROVIDER_ID, cause: e });
  }
  if (status === 503) {
    return new AdapterError("overloaded", msg, { httpStatus: status, providerId: PROVIDER_ID, cause: e });
  }
  if (status === 400) {
    const code = /context|token|too long|maximum/i.test(rawMsg) ? "context_length" : "invalid_request";
    return new AdapterError(code, msg, { httpStatus: status, providerId: PROVIDER_ID, cause: e });
  }
  if (status === 404) {
    return new AdapterError("invalid_request", msg, { httpStatus: status, providerId: PROVIDER_ID, cause: e });
  }
  return new AdapterError("transport", msg, {
    ...(typeof status === "number" ? { httpStatus: status } : {}),
    providerId: PROVIDER_ID,
    cause: e,
  });
}

// ── Capabilities ─────────────────────────────────────────────────────────────────

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
 * Real Gemini/Vertex model discovery via `ai.models.list()`. Shared by both the
 * Gemini and Vertex adapters (same SDK, same `models.list`). Model `name`s come
 * back namespaced (`"models/gemini-2.0-flash"`); the `"models/"` prefix is
 * stripped to the native id. Falls back to `fallback` when the client exposes no
 * `list`, the call fails, or the result is empty. Never throws.
 */
export async function listGeminiModels(
  getClient: () => Promise<GeminiClientLike> | GeminiClientLike,
  fallback: ModelInfo[],
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  try {
    const client = await getClient();
    if (typeof client.models.list !== "function") return fallback;
    const pager = await client.models.list();
    const seen = new Set<string>();
    const out: ModelInfo[] = [];
    for await (const m of pager) {
      if (signal?.aborted) break;
      const raw = typeof m?.name === "string" ? m.name : "";
      const id = raw.replace(/^models\//, "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, modalities: ["text", "image", "audio"] });
    }
    return out.length > 0 ? out : fallback;
  } catch {
    return fallback;
  }
}

// ── Adapter factory ──────────────────────────────────────────────────────────────

/**
 * Create the native Gemini {@link ProviderAdapter}. `cred` is optional and only
 * used for the Gemini Developer API (an API key); Vertex mode authenticates via
 * GCP Application Default Credentials and needs no key. The SDK client is built
 * once, lazily, on first use.
 */
export function createGeminiAdapter(
  cfg: GeminiConfig,
  cred?: CredentialResolver,
): ProviderAdapter {
  const transport: TransportKind = "http-sdk";
  const label = cfg.vertex ? "Google Vertex (Gemini)" : "Google Gemini";
  let client: GeminiClientLike | undefined;
  const modelCache = createModelListCache();

  const resolveKey: CredentialResolver =
    cred ?? (() => process.env[GEMINI_API_KEY_ENV] ?? "");

  const getClient = async (): Promise<GeminiClientLike> => {
    if (!client) {
      if (cfg.createClient) {
        // The seam receives the resolved key so DI tests can assert on it too.
        const key = cfg.vertex ? "" : await resolveKey();
        client = cfg.createClient(key);
      } else if (cfg.vertex) {
        const opts: ConstructorParameters<typeof GoogleGenAI>[0] = { vertexai: true };
        if (cfg.project !== undefined) opts.project = cfg.project;
        if (cfg.location !== undefined) opts.location = cfg.location;
        if (cfg.apiVersion !== undefined) opts.apiVersion = cfg.apiVersion;
        client = new GoogleGenAI(opts) as unknown as GeminiClientLike;
      } else {
        const apiKey = await resolveKey();
        if (!apiKey) {
          throw new AdapterError("auth", `No Gemini API key (set ${GEMINI_API_KEY_ENV}).`, {
            providerId: PROVIDER_ID,
          });
        }
        const opts: ConstructorParameters<typeof GoogleGenAI>[0] = { apiKey };
        if (cfg.apiVersion !== undefined) opts.apiVersion = cfg.apiVersion;
        client = new GoogleGenAI(opts) as unknown as GeminiClientLike;
      }
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
      const gemini = await getClient();
      iterator = await gemini.models.generateContentStream(toGeminiRequest(cfg, req));
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
        for (const mapped of mapGeminiChunk(view, runId)) {
          if (mapped.type === "text-delta") answer.push(mapped.text);
          else if (mapped.type === "reasoning-delta") reasoning.push(mapped.text);
          else if (mapped.type === "tool-call-end") {
            toolBlocks.push({ type: "tool_use", id: mapped.id, name: nameOf(view, mapped.id), input: mapped.input });
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
      throw new AdapterError("empty_output", "Gemini adapter produced no output.", {
        providerId: PROVIDER_ID,
      });
    }

    const result: ChatResult = { message, finishReason };
    if (usage) result.usage = usage;
    return result;
  }

  const health = async (ctx: CallContext): Promise<HealthStatus> => {
    try {
      await getClient();
    } catch (e) {
      const err = mapError(e);
      return { ok: false, detail: `${err.code}: ${err.message}` };
    }
    if (ctx.signal.aborted) return { ok: false, detail: "aborted" };
    return { ok: true, detail: `${label} client ready` };
  };

  const listModels = (ctx?: CallContext): Promise<ModelInfo[]> =>
    modelCache.get(() => listGeminiModels(getClient, DEFAULT_GEMINI_MODELS, ctx?.signal));

  const dispose = async (): Promise<void> => {
    client = undefined;
  };

  return {
    id: PROVIDER_ID,
    label,
    transport,
    capabilities,
    chat,
    stream,
    listModels,
    health,
    dispose,
  };
}

/** Recover a tool name for a given call id from a chunk's function-call parts. */
function nameOf(chunk: GeminiChunkLike, id: string): string {
  for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
    if (p.functionCall && (p.functionCall.id ?? p.functionCall.name) === id) {
      return p.functionCall.name ?? "";
    }
  }
  return "";
}
