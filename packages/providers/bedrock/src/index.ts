/**
 * @nexuscode/provider-bedrock — a native {@link ProviderAdapter} over Amazon
 * Bedrock's Converse / ConverseStream API (`@aws-sdk/client-bedrock-runtime`).
 *
 * The Converse API is model-agnostic: one request/stream shape spans Anthropic,
 * Meta, Mistral, Amazon Nova and more, so a single adapter routes to any Bedrock
 * model by id. Everything is normalized into the canonical {@link StreamChunk}
 * union so the rest of NexusCode never sees a Bedrock-shaped object.
 *
 * Auth uses the standard AWS credential chain (env vars, shared config, SSO,
 * container/instance roles) resolved lazily by the SDK — no key is read here and
 * no client is built until the first `stream`/`chat` call, so importing and
 * constructing the adapter (and probing its capabilities) is offline and
 * side-effect free.
 */

import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  ContentBlock as BedrockContentBlock,
  ConverseStreamCommandInput,
  ConverseStreamOutput,
  ImageFormat,
  Message as BedrockMessage,
  SystemContentBlock,
  Tool as BedrockTool,
  ToolChoice as BedrockToolChoice,
} from "@aws-sdk/client-bedrock-runtime";
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
import { AdapterError } from "@nexuscode/shared";

const PROVIDER_ID = "bedrock";

/**
 * The narrow surface of the Bedrock runtime this adapter calls. Declaring it as
 * a seam lets tests inject a fake that yields canned Converse stream events
 * without constructing the real AWS client or touching the network.
 */
export interface BedrockClientLike {
  converseStream(
    input: ConverseStreamCommandInput,
  ): Promise<{ stream?: AsyncIterable<ConverseStreamOutput> | undefined }>;
}

/** Static configuration for {@link createBedrockAdapter}. */
export interface BedrockConfig {
  /** Logical model id → native Bedrock model/inference-profile id. */
  modelMap: Record<string, string>;
  /** AWS region (else the SDK's default resolution chain applies). */
  region?: string;
  /** Default `maxTokens` when a request omits one. Default `4096`. */
  defaultMaxTokens?: number;
  /** Per-model capability overrides (e.g. a text-only model → `vision:false`). */
  capabilityOverrides?: Partial<Pick<Capabilities, "vision" | "tools" | "reasoning">>;
  /**
   * Test/di seam: build the client. When omitted, a real
   * {@link BedrockRuntimeClient} is created lazily on first use.
   */
  createClient?: () => BedrockClientLike;
}

// ── Request translation ────────────────────────────────────────────────────────

function imageFormatFromMime(mime: string): ImageFormat {
  const sub = mime.split("/")[1]?.toLowerCase() ?? "png";
  if (sub === "jpg") return "jpeg" as ImageFormat;
  return sub as ImageFormat;
}

/** Map one canonical content block to zero-or-more Bedrock content blocks. */
function mapContentBlock(b: ContentBlock): BedrockContentBlock[] {
  switch (b.type) {
    case "text":
      return [{ text: b.text }];
    case "image": {
      if (typeof b.data === "string") {
        return [
          {
            image: {
              format: imageFormatFromMime(b.mime),
              source: { bytes: base64ToBytes(b.data) },
            },
          } as BedrockContentBlock,
        ];
      }
      return [{ text: `[image: ${b.data.url}]` }];
    }
    case "tool_use":
      return [
        {
          toolUse: {
            toolUseId: b.id,
            name: b.name,
            input: (b.input ?? {}) as Record<string, unknown>,
          },
        } as BedrockContentBlock,
      ];
    case "tool_result":
      return [
        {
          toolResult: {
            toolUseId: b.toolCallId,
            content: [{ text: b.content.map(textFromBlock).join("") }],
            status: (b.isError ? "error" : "success") as "error" | "success",
          },
        } as BedrockContentBlock,
      ];
    case "thinking":
      // Reasoning is model output; not re-sent as request input in Converse.
      return [];
    default:
      return [];
  }
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
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

/** Canonical messages → Bedrock `Message[]`. `system` is hoisted; `tool` → `user`. */
export function mapMessages(messages: Message[]): BedrockMessage[] {
  const out: BedrockMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") continue; // hoisted to the top-level `system` field
    const content = m.content.flatMap(mapContentBlock);
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content });
  }
  return out;
}

function mapTools(tools: ToolDef[] | undefined): BedrockTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map(
    (t) =>
      ({
        toolSpec: {
          name: t.name,
          ...(t.description !== undefined ? { description: t.description } : {}),
          inputSchema: { json: t.parameters },
        },
      }) as BedrockTool,
  );
}

function mapToolChoice(tc: ChatRequest["toolChoice"]): BedrockToolChoice | undefined {
  if (tc === undefined || tc === "none") return undefined;
  if (tc === "auto") return { auto: {} };
  if (tc === "required") return { any: {} };
  return { tool: { name: tc.name } };
}

/** Build the native ConverseStream input from a canonical {@link ChatRequest}. */
export function toBedrockRequest(
  cfg: BedrockConfig,
  req: ChatRequest,
): ConverseStreamCommandInput {
  const modelId = cfg.modelMap[req.model] ?? req.model;
  const dropTools = req.toolChoice === "none";

  const input: ConverseStreamCommandInput = {
    modelId,
    messages: mapMessages(req.messages),
    inferenceConfig: { maxTokens: req.maxTokens ?? cfg.defaultMaxTokens ?? 4096 },
  };
  if (req.system !== undefined) {
    input.system = [{ text: req.system } as SystemContentBlock];
  }
  if (req.temperature !== undefined) {
    input.inferenceConfig = { ...input.inferenceConfig, temperature: req.temperature };
  }
  const tools = dropTools ? undefined : mapTools(req.tools);
  if (tools) {
    const toolChoice = mapToolChoice(req.toolChoice);
    input.toolConfig = { tools, ...(toolChoice ? { toolChoice } : {}) };
  }
  if (req.providerExtensions) {
    Object.assign(input, req.providerExtensions);
  }
  return input;
}

// ── Response translation ────────────────────────────────────────────────────────

function mapStop(stop: string | undefined): FinishReason {
  switch (stop) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    case "content_filtered":
    case "guardrail_intervened":
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
    case undefined:
      return "stop";
    default:
      return "stop";
  }
}

/** Per-stream mutable state: open tool blocks by content-block index. */
export interface BedrockStreamState {
  blocks: Map<number, { id: string; name: string; json: string }>;
}

export function newBedrockStreamState(): BedrockStreamState {
  return { blocks: new Map() };
}

/**
 * Map one native ConverseStream event to canonical {@link StreamChunk}s (pure).
 * `state` accumulates streamed tool-call JSON so the terminal `contentBlockStop`
 * can emit a complete `tool-call-end` with parsed input.
 */
export function mapBedrockEvent(
  ev: ConverseStreamOutput,
  runId: string,
  state: BedrockStreamState,
): StreamChunk[] {
  const e = ev as unknown as Record<string, unknown>;
  const out: StreamChunk[] = [];

  if (e.contentBlockStart) {
    const cb = e.contentBlockStart as { start?: { toolUse?: { toolUseId?: string; name?: string } }; contentBlockIndex?: number };
    const tu = cb.start?.toolUse;
    if (tu) {
      const idx = cb.contentBlockIndex ?? 0;
      const id = tu.toolUseId ?? `tool_${idx}`;
      state.blocks.set(idx, { id, name: tu.name ?? "", json: "" });
      out.push({ type: "tool-call-start", runId, id, name: tu.name ?? "", raw: ev });
    }
  } else if (e.contentBlockDelta) {
    const cb = e.contentBlockDelta as { delta?: { text?: string; toolUse?: { input?: string }; reasoningContent?: { text?: string } }; contentBlockIndex?: number };
    const idx = cb.contentBlockIndex ?? 0;
    const delta = cb.delta;
    if (delta?.text) {
      out.push({ type: "text-delta", runId, text: delta.text, channel: "answer", raw: ev });
    } else if (delta?.reasoningContent?.text) {
      out.push({ type: "reasoning-delta", runId, text: delta.reasoningContent.text, raw: ev });
    } else if (delta?.toolUse) {
      const open = state.blocks.get(idx);
      const argsJsonDelta = delta.toolUse.input ?? "";
      if (open) open.json += argsJsonDelta;
      const id = open?.id ?? `tool_${idx}`;
      out.push({ type: "tool-call-delta", runId, id, argsJsonDelta, raw: ev });
    }
  } else if (e.contentBlockStop) {
    const cb = e.contentBlockStop as { contentBlockIndex?: number };
    const idx = cb.contentBlockIndex ?? 0;
    const open = state.blocks.get(idx);
    if (open) {
      out.push({ type: "tool-call-end", runId, id: open.id, input: safeParse(open.json), raw: ev });
    }
  } else if (e.metadata) {
    const md = e.metadata as { usage?: { inputTokens?: number; outputTokens?: number } };
    if (md.usage) {
      out.push({
        type: "usage",
        runId,
        usage: { inputTokens: md.usage.inputTokens ?? 0, outputTokens: md.usage.outputTokens ?? 0 },
        raw: ev,
      });
    }
  }
  return out;
}

function safeParse(json: string): unknown {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// ── Error mapping ────────────────────────────────────────────────────────────────

function redactSecrets(msg: string): string {
  return msg
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{8,}\b/g, "***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***");
}

interface AwsIshError {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

/** Map any SDK / transport failure onto the normalized {@link AdapterError}. */
export function mapError(e: unknown): AdapterError {
  if (e instanceof AdapterError) return e;
  const err = e as AwsIshError;
  const status = err?.$metadata?.httpStatusCode;
  const name = err?.name ?? "";
  const msg = redactSecrets(e instanceof Error ? e.message : err?.message ?? "unknown Bedrock transport error");
  const opts = { ...(status !== undefined ? { httpStatus: status } : {}), providerId: PROVIDER_ID, cause: e };

  if (name === "AccessDeniedException" || name === "UnrecognizedClientException" || status === 401 || status === 403) {
    return new AdapterError("auth", msg, opts);
  }
  if (name === "ThrottlingException" || status === 429) {
    return new AdapterError("rate_limit", msg, opts);
  }
  if (name === "ServiceUnavailableException" || name === "ModelTimeoutException" || name === "InternalServerException" || status === 503) {
    return new AdapterError("overloaded", msg, opts);
  }
  if (name === "ValidationException" || status === 400) {
    const code = /context|token|too long|maximum|input is too/i.test(msg) ? "context_length" : "invalid_request";
    return new AdapterError(code, msg, opts);
  }
  if (name === "ResourceNotFoundException" || status === 404) {
    return new AdapterError("invalid_request", msg, opts);
  }
  return new AdapterError("transport", msg, opts);
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
    const info: ModelInfo = { id: native, modalities: ["text", "image"] };
    if (aliases.length > 0) info.aliases = aliases;
    infos.push(info);
  }
  return infos;
}

// ── Adapter factory ──────────────────────────────────────────────────────────────

/**
 * Create the native Bedrock {@link ProviderAdapter}. The AWS client is built
 * once, lazily, on first use; credentials resolve through the standard AWS
 * chain at request time.
 */
export function createBedrockAdapter(cfg: BedrockConfig): ProviderAdapter {
  const transport: TransportKind = "http-sdk";
  let client: BedrockClientLike | undefined;

  const getClient = (): BedrockClientLike => {
    if (client) return client;
    if (cfg.createClient) {
      client = cfg.createClient();
    } else {
      const aws = new BedrockRuntimeClient(cfg.region ? { region: cfg.region } : {});
      client = {
        converseStream: (input) => aws.send(new ConverseStreamCommand(input)),
      };
    }
    return client;
  };

  const capabilities = async (): Promise<Capabilities> => ({
    models: buildModelInfos(cfg.modelMap),
    streaming: true,
    tools: cfg.capabilityOverrides?.tools ?? true,
    parallelToolCalls: true,
    vision: cfg.capabilityOverrides?.vision ?? true,
    structuredOutput: false,
    reasoning: cfg.capabilityOverrides?.reasoning ?? true,
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
    const modelId = cfg.modelMap[req.model] ?? req.model;

    yield { type: "run-start", runId, adapterId: PROVIDER_ID, model: modelId, ts: Date.now() };

    if (ctx.signal.aborted) {
      const error = new AdapterError("cancelled", "aborted", { providerId: PROVIDER_ID });
      yield { type: "error", runId, error, retryable: error.retryable };
      return;
    }

    let response: { stream?: AsyncIterable<ConverseStreamOutput> | undefined };
    try {
      response = await getClient().converseStream(toBedrockRequest(cfg, req));
    } catch (e) {
      const error = ctx.signal.aborted
        ? new AdapterError("cancelled", "aborted", { providerId: PROVIDER_ID })
        : mapError(e);
      yield { type: "error", runId, error, retryable: error.retryable };
      return;
    }

    const state = newBedrockStreamState();
    const answer: string[] = [];
    const reasoning: string[] = [];
    const toolBlocks: Array<Extract<ContentBlock, { type: "tool_use" }>> = [];
    const toolNames = new Map<string, string>();
    let usage: Usage | undefined;
    let finishReason: FinishReason = "stop";

    try {
      for await (const ev of response.stream ?? []) {
        if (ctx.signal.aborted) {
          const error = new AdapterError("cancelled", "aborted", { providerId: PROVIDER_ID });
          yield { type: "error", runId, error, retryable: error.retryable };
          return;
        }
        const ms = (ev as unknown as Record<string, unknown>).messageStop as { stopReason?: string } | undefined;
        if (ms?.stopReason) finishReason = mapStop(ms.stopReason);

        for (const mapped of mapBedrockEvent(ev, runId, state)) {
          if (mapped.type === "text-delta") answer.push(mapped.text);
          else if (mapped.type === "reasoning-delta") reasoning.push(mapped.text);
          else if (mapped.type === "tool-call-start") toolNames.set(mapped.id, mapped.name);
          else if (mapped.type === "tool-call-end") {
            toolBlocks.push({ type: "tool_use", id: mapped.id, name: toolNames.get(mapped.id) ?? "", input: mapped.input });
          } else if (mapped.type === "usage") {
            usage = { inputTokens: mapped.usage.inputTokens ?? 0, outputTokens: mapped.usage.outputTokens ?? 0 };
          }
          yield mapped;
        }
      }

      const content: ContentBlock[] = [];
      if (reasoning.length) content.push({ type: "thinking", text: reasoning.join("") });
      if (answer.length) content.push({ type: "text", text: answer.join("") });
      for (const tb of toolBlocks) content.push(tb);

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
      throw new AdapterError("empty_output", "Bedrock adapter produced no output.", {
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
    return { ok: true, detail: "Bedrock client ready (AWS credential chain)" };
  };

  // The Bedrock *runtime* client (Converse) has no model-listing operation —
  // that lives in the separate control-plane SDK, which needs credentials we do
  // not require here. So model discovery returns the curated, config-driven
  // catalog (the models the deployment is wired for). Never throws.
  const listModels = async (): Promise<ModelInfo[]> => buildModelInfos(cfg.modelMap);

  const dispose = async (): Promise<void> => {
    client = undefined;
  };

  return {
    id: PROVIDER_ID,
    label: "Amazon Bedrock",
    transport,
    capabilities,
    chat,
    stream,
    listModels,
    health,
    dispose,
  };
}
