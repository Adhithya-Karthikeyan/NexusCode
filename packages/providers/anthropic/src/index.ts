/**
 * @nexuscode/provider-anthropic — a native {@link ProviderAdapter} over the
 * official `@anthropic-ai/sdk`.
 *
 * Native transport (rather than the OpenAI-compat multiplexer) is used so the
 * adapter can expose Anthropic-specific power end-to-end: extended thinking
 * (`reasoning`), prompt-cache token accounting, and tool use — all normalized
 * into the canonical {@link StreamChunk} union so the rest of NexusCode never
 * sees an Anthropic-shaped object.
 *
 * The SDK's own retry loop is disabled (`maxRetries: 0`) because retries are
 * centralized in the core resilience layer (`withRetry`); double-retrying would
 * multiply backoff and defeat idempotency accounting.
 */

import type { Agent as HttpAgent } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import Anthropic from "@anthropic-ai/sdk";
import { sharedAgentFor } from "@nexuscode/shared";
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

const PROVIDER_ID = "anthropic";

/** Default base URL for the Anthropic REST API (models discovery + Messages). */
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/** The `anthropic-version` header value sent to the REST API. */
const ANTHROPIC_VERSION = "2023-06-01";

/**
 * A curated snapshot of current selectable Claude models. Used as the graceful
 * fallback for {@link ProviderAdapter.listModels} when the live `/v1/models`
 * endpoint cannot be reached (no key, offline, error). Pricing/context stay
 * config-driven — this is only the id catalog.
 */
export const DEFAULT_ANTHROPIC_MODELS: ModelInfo[] = [
  { id: "claude-opus-4-1", modalities: ["text", "image"] },
  { id: "claude-opus-4-0", modalities: ["text", "image"] },
  { id: "claude-sonnet-4-5", modalities: ["text", "image"] },
  { id: "claude-sonnet-4-0", modalities: ["text", "image"] },
  { id: "claude-3-7-sonnet-latest", modalities: ["text", "image"] },
  { id: "claude-3-5-haiku-latest", modalities: ["text", "image"] },
];

/** Static configuration for {@link createAnthropicAdapter}. */
export interface AnthropicConfig {
  /** Logical model id → native Anthropic model id (e.g. `"claude"` → `"claude-3-5-sonnet-latest"`). */
  modelMap: Record<string, string>;
  /** Override the API base URL (proxies, gateways). */
  baseURL?: string;
  /** Static headers injected into every request (e.g. a private-gateway org token). Never secrets. */
  defaultHeaders?: Record<string, string>;
  /** Default `max_tokens` when a request omits one. Default `4096`. */
  defaultMaxTokens?: number;
  /** Default thinking budget (tokens) when reasoning is enabled without a budget. Default `8000`. */
  defaultThinkingBudget?: number;
  /**
   * Explicit keep-alive HTTP(S) agent for the SDK's socket pool (system-spec §23:
   * connection pooling). Omit to use the process-wide shared agent so sockets are
   * reused across calls; pass one only to isolate/tune this provider or inject a
   * spy in tests.
   */
  httpAgent?: HttpAgent | HttpsAgent;
  /**
   * OAuth-aware credential source (additive). When set, it takes precedence over
   * the positional `cred` and lets the adapter send an auto-refreshed OAuth
   * Bearer access token (a Claude account login, "like Claude Code") instead of
   * an `x-api-key`. Wired by `@nexuscode/auth`'s Anthropic strategy. Omit to keep
   * the legacy api-key path (`cred`) unchanged.
   */
  credential?: AnthropicCredentialSource;
  /**
   * Test/DI seam: the `fetch` used by {@link ProviderAdapter.listModels} to query
   * `GET {baseURL}/v1/models`. Defaults to the global `fetch`. Injected in tests
   * to parse a canned models response with no live network.
   */
  fetchImpl?: typeof fetch;
}

/** A credential resolver — invoked lazily so no key is read until first use. */
export type CredentialResolver = () => Promise<string>;

/**
 * A resolved credential and how it must be sent. `"api-key"` → the `x-api-key`
 * header (Anthropic console key); `"bearer"` → an `Authorization: Bearer` OAuth
 * access token (a Claude ACCOUNT login, "like Claude Code"), auto-refreshed by
 * @nexuscode/auth. `"none"` → no credential resolvable (surfaced as an `auth`
 * failure only when actually used). The value is NEVER logged.
 */
export interface AnthropicResolvedCredential {
  kind: "bearer" | "api-key" | "none";
  value: string;
}

/**
 * A richer credential source that reports whether it resolved an OAuth Bearer
 * token or an API key — the additive wiring point for `@nexuscode/auth`'s
 * Anthropic strategy. When `AnthropicConfig.credential` is set it takes
 * precedence over the positional `cred` (the legacy api-key resolver).
 */
export type AnthropicCredentialSource = () => Promise<AnthropicResolvedCredential>;

/** The beta opt-in header the Messages API requires for an OAuth bearer token. */
const ANTHROPIC_OAUTH_BETA_HEADER = "oauth-2025-04-20";

/**
 * A Claude.ai *subscription* OAuth token (minted via the Claude Code login flow,
 * `claude.com/cai/oauth/authorize`) is accepted by `GET /v1/models` but REJECTED
 * by `POST /v1/messages` (401, turn yields no content) unless the request's FIRST
 * system block identifies the caller as Claude Code. This is the exact identity
 * string the real Claude Code CLI sends. It is prepended as a separate leading
 * system block ONLY for OAuth bearer credentials; console api-key requests keep
 * their plain string system prompt and are unaffected.
 */
const CLAUDE_CODE_SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Build the SDK {@link Anthropic} client options for a resolved credential. A
 * `"bearer"` credential sets `authToken` (→ `Authorization: Bearer …`) plus the
 * OAuth beta header and NEVER sets `apiKey`; an `"api-key"` credential sets
 * `apiKey` (→ `x-api-key`). Pure and offline — exported so the credential →
 * header wiring can be verified without a network or a live SDK request.
 */
export function buildAnthropicClientOptions(
  cfg: AnthropicConfig,
  resolved: AnthropicResolvedCredential,
): NonNullable<ConstructorParameters<typeof Anthropic>[0]> {
  const opts: NonNullable<ConstructorParameters<typeof Anthropic>[0]> = { maxRetries: 0 };
  if (cfg.baseURL !== undefined) opts.baseURL = cfg.baseURL;
  const headers: Record<string, string> = { ...(cfg.defaultHeaders ?? {}) };
  if (resolved.kind === "bearer") {
    opts.authToken = resolved.value;
    // Explicitly null the api key so the SDK never falls back to the ambient
    // ANTHROPIC_API_KEY env and sends an x-api-key alongside the Bearer token.
    opts.apiKey = null;
    // The Messages API requires this beta opt-in for an OAuth bearer token.
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "anthropic-beta")) {
      headers["anthropic-beta"] = ANTHROPIC_OAUTH_BETA_HEADER;
    }
  } else {
    // "api-key" (or "none" → empty key, surfaced as an auth error on first use).
    opts.apiKey = resolved.value;
  }
  if (Object.keys(headers).length > 0) opts.defaultHeaders = headers;
  return opts;
}

// ── Widened SDK views ─────────────────────────────────────────────────────────
// The pinned SDK's typed unions predate extended-thinking, so `thinking_delta`,
// `signature_delta`, thinking content blocks, and prompt-cache usage fields are
// not in its declarations even though the wire protocol emits them. These narrow
// structural views let us read those fields without `any` and without silently
// dropping reasoning output.

interface WidenedDelta {
  type: string;
  text?: string;
  thinking?: string;
  partial_json?: string;
  signature?: string;
}

interface WidenedBlock {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface WidenedUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

// ── Request translation ────────────────────────────────────────────────────────

type SdkImageSource = { type: "base64"; media_type: string; data: string };

/** Map one canonical content block to the SDK's outbound block param(s). */
function mapContentBlock(
  b: ContentBlock,
):
  | Anthropic.TextBlockParam
  | Anthropic.ImageBlockParam
  | Anthropic.ToolUseBlockParam
  | Anthropic.ToolResultBlockParam
  | undefined {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "image": {
      // A pre-encoded string maps to a base64 image source. A URL reference maps
      // to a `{ type: "url" }` source: the Messages API accepts it on the wire even
      // though the pinned SDK's typed source union predates it, so it is attached
      // structurally (the same escape hatch used for extended `thinking`).
      if (typeof b.data === "string") {
        const source: SdkImageSource = { type: "base64", media_type: b.mime, data: b.data };
        return { type: "image", source } as Anthropic.ImageBlockParam;
      }
      const urlSource = { type: "url", url: b.data.url };
      return { type: "image", source: urlSource } as unknown as Anthropic.ImageBlockParam;
    }
    case "audio":
      // Anthropic's Messages API has no audio input block; fold to a lossless text
      // note so the request stays valid rather than silently dropping the block.
      return { type: "text", text: typeof b.data === "string" ? `[audio: ${b.mime}]` : `[audio: ${b.data.url}]` };
    case "tool_use":
      return { type: "tool_use", id: b.id, name: b.name, input: b.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: b.toolCallId,
        content: mapToolResultContent(b.content),
        ...(b.isError !== undefined ? { is_error: b.isError } : {}),
      };
    case "thinking":
      // Thinking blocks are model output; they are not re-sent as request input
      // in this SDK's param shape, so they are dropped from outbound messages.
      return undefined;
    default:
      return undefined;
  }
}

/** Tool-result inner content → the SDK's restricted text/image param array. */
function mapToolResultContent(
  content: ContentBlock[],
): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
  const out: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  for (const b of content) {
    if (b.type === "text") {
      out.push({ type: "text", text: b.text });
    } else if (b.type === "image" && typeof b.data === "string") {
      const source: SdkImageSource = { type: "base64", media_type: b.mime, data: b.data };
      out.push({ type: "image", source } as Anthropic.ImageBlockParam);
    } else {
      // Fold any other block into a textual summary so the result stays valid.
      out.push({ type: "text", text: textFromBlock(b) });
    }
  }
  return out;
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
    case "audio":
      return typeof b.data === "string" ? "[audio]" : `[audio: ${b.data.url}]`;
    default:
      return "";
  }
}

/**
 * Canonical messages → SDK `MessageParam[]`. `system` is hoisted to the top-level
 * `system` field; a `tool` role becomes a USER turn carrying a `tool_result`
 * block that references the originating `tool_use` id. Consecutive tool results
 * are batched into ONE user message — Anthropic requires every `tool_use`
 * answered by a `tool_result` in the immediately-following user turn, and
 * parallel tool calls must share a single user message.
 */
function mapMessages(messages: Message[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  let pending: NonNullable<ReturnType<typeof mapContentBlock>>[] = [];
  const flush = (): void => {
    if (pending.length > 0) {
      out.push({ role: "user", content: pending });
      pending = [];
    }
  };
  for (const m of messages) {
    if (m.role === "system") continue; // hoisted to the top-level `system` field
    if (m.role === "tool") {
      // CRITICAL: a tool result MUST be a `tool_result` block keyed by the
      // originating `tool_use` id, or Anthropic 400s ("tool_use ids were found
      // without tool_result blocks") and the turn dies with NO answer. Collapsing
      // it to a plain-text user message (the prior behavior) silently broke every
      // tool-using turn. Route it through mapContentBlock's tool_result handling.
      const block = mapContentBlock({
        type: "tool_result",
        toolCallId: m.toolCallId ?? "",
        content: m.content,
      });
      if (block) pending.push(block);
      continue;
    }
    flush();
    const content = m.content
      .map(mapContentBlock)
      .filter((c): c is NonNullable<typeof c> => c !== undefined);
    out.push({ role: m.role === "assistant" ? "assistant" : "user", content });
  }
  flush();
  return out;
}

function mapTools(tools: ToolDef[] | undefined): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.name,
    ...(t.description !== undefined ? { description: t.description } : {}),
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  }));
}

function mapToolChoice(tc: ChatRequest["toolChoice"]): Anthropic.ToolChoice | undefined {
  if (tc === undefined) return undefined;
  if (tc === "auto") return { type: "auto" };
  if (tc === "required") return { type: "any" };
  if (tc === "none") return undefined; // no native "none"; caller also drops tools
  return { type: "tool", name: tc.name };
}

/** Canonical messages → SDK `MessageParam[]`. Exported for offline shape tests. */
export function mapMessagesToNative(messages: Message[]): Anthropic.MessageParam[] {
  return mapMessages(messages);
}

/**
 * Build the native streaming request from a canonical {@link ChatRequest}.
 * Exported as {@link toNativeRequest} so the content-block → native shape mapping
 * can be verified offline without any network or SDK client. `oauth` prepends the
 * Claude Code identity system block required by subscription OAuth tokens.
 */
export function toNativeRequest(
  cfg: AnthropicConfig,
  req: ChatRequest,
  oauth = false,
): Anthropic.MessageStreamParams {
  const nativeModel = cfg.modelMap[req.model] ?? req.model;
  const dropTools = req.toolChoice === "none";

  const base: Anthropic.MessageStreamParams = {
    model: nativeModel,
    max_tokens: req.maxTokens ?? cfg.defaultMaxTokens ?? 4096,
    messages: mapMessages(req.messages),
  };
  // OAuth (Claude subscription) tokens REQUIRE the Claude Code identity as the
  // FIRST system block or `/v1/messages` 401s and the turn returns no content.
  // Prepend it as a separate leading block, preserving any caller system prompt
  // as a second block. Console api-key requests keep the plain string form.
  if (oauth) {
    const idBlock = { type: "text" as const, text: CLAUDE_CODE_SYSTEM_IDENTITY };
    base.system =
      req.system !== undefined && req.system.trim() !== ""
        ? [idBlock, { type: "text" as const, text: req.system }]
        : [idBlock];
  } else if (req.system !== undefined) {
    base.system = req.system;
  }
  if (req.temperature !== undefined) base.temperature = req.temperature;

  const tools = dropTools ? undefined : mapTools(req.tools);
  if (tools) base.tools = tools;
  const toolChoice = mapToolChoice(req.toolChoice);
  if (toolChoice) base.tool_choice = toolChoice;

  // `thinking` (extended reasoning) is not in the pinned SDK's param type but is
  // accepted on the wire; attach it structurally.
  const extras: Record<string, unknown> = { ...(req.providerExtensions ?? {}) };
  if (req.reasoning?.enabled) {
    extras.thinking = {
      type: "enabled",
      budget_tokens: req.reasoning.budgetTokens ?? cfg.defaultThinkingBudget ?? 8000,
    };
  }
  return { ...base, ...extras } as Anthropic.MessageStreamParams;
}

// ── Response translation ────────────────────────────────────────────────────────

function mapStop(stop: Anthropic.Message["stop_reason"]): FinishReason {
  switch (stop) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_use";
    case "end_turn":
    case "stop_sequence":
    case null:
    case undefined:
      return "stop";
    default:
      return "stop";
  }
}

function mapUsage(u: WidenedUsage): Usage {
  const usage: Usage = {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
  };
  if (u.cache_read_input_tokens != null) usage.cacheReadTokens = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens != null) usage.cacheWriteTokens = u.cache_creation_input_tokens;
  return usage;
}

/** SDK final message → canonical assistant {@link Message}. */
function fromNative(final: Anthropic.Message): Message {
  const content: ContentBlock[] = [];
  for (const raw of final.content as unknown as WidenedBlock[]) {
    if (raw.type === "text") {
      content.push({ type: "text", text: raw.text ?? "" });
    } else if (raw.type === "tool_use") {
      content.push({ type: "tool_use", id: raw.id ?? "", name: raw.name ?? "", input: raw.input });
    } else if (raw.type === "thinking") {
      const block: Extract<ContentBlock, { type: "thinking" }> = {
        type: "thinking",
        text: raw.thinking ?? raw.text ?? "",
      };
      if (raw.signature !== undefined) block.signature = raw.signature;
      content.push(block);
    }
  }
  return { role: "assistant", content };
}

// ── Error mapping ────────────────────────────────────────────────────────────────

/** The pinned SDK models headers as a plain record, not a DOM `Headers`. */
type SdkHeaders = Record<string, string | null | undefined>;

function parseRetryAfter(headers: SdkHeaders | undefined): number | undefined {
  if (!headers) return undefined;
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/**
 * Redact secret-looking tokens from a backend error message before it becomes
 * an {@link AdapterError}'s `message` — a backend can echo the offending
 * credential verbatim in a 401/403 body, and that string must never reach
 * logs/UI. Matches common provider key prefixes plus a bare `Bearer <token>`.
 */
function redactSecrets(msg: string): string {
  return msg
    .replace(/\b(sk|xai|gsk|nvapi|or)-[A-Za-z0-9_-]{6,}\b/gi, "***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***");
}

/** Map any SDK / transport failure onto the normalized {@link AdapterError}. */
export function mapError(e: unknown): AdapterError {
  if (e instanceof Anthropic.APIError) {
    const s = e.status;
    const msg = redactSecrets(e.message);
    if (s === 401 || s === 403) {
      return new AdapterError("auth", msg, { httpStatus: s, providerId: PROVIDER_ID, cause: e });
    }
    if (s === 429) {
      const retryAfterMs = parseRetryAfter(e.headers);
      return new AdapterError("rate_limit", msg, {
        httpStatus: s,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        providerId: PROVIDER_ID,
        cause: e,
      });
    }
    if (s === 529) {
      return new AdapterError("overloaded", msg, { httpStatus: s, providerId: PROVIDER_ID, cause: e });
    }
    if (s === 400) {
      const code = /context|token|too long|maximum/i.test(e.message) ? "context_length" : "invalid_request";
      return new AdapterError(code, msg, { httpStatus: s, providerId: PROVIDER_ID, cause: e });
    }
    if (s === 404) {
      return new AdapterError("invalid_request", msg, { httpStatus: s, providerId: PROVIDER_ID, cause: e });
    }
    // 5xx and anything else server-side: transient by taxonomy default.
    return new AdapterError("transport", msg, {
      ...(s !== undefined ? { httpStatus: s } : {}),
      providerId: PROVIDER_ID,
      cause: e,
    });
  }
  const message = e instanceof Error ? redactSecrets(e.message) : "unknown Anthropic transport error";
  return new AdapterError("transport", message, { providerId: PROVIDER_ID, cause: e });
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

/**
 * Resolve the auth header for a REST call the same way the SDK client does:
 * an OAuth bearer credential → `Authorization: Bearer …`; an api-key credential
 * → `x-api-key`. `"none"`/empty → no auth header (surfaced as a 401 on use).
 */
async function resolveAuthHeaders(
  cfg: AnthropicConfig,
  cred: CredentialResolver,
): Promise<Record<string, string>> {
  const resolved: AnthropicResolvedCredential = cfg.credential
    ? await cfg.credential()
    : { kind: "api-key", value: await cred() };
  if (resolved.kind === "bearer" && resolved.value) {
    return {
      Authorization: `Bearer ${resolved.value}`,
      "anthropic-beta": ANTHROPIC_OAUTH_BETA_HEADER,
    };
  }
  if (resolved.value) return { "x-api-key": resolved.value };
  return {};
}

/**
 * Real model discovery: `GET {baseURL}/v1/models` with the resolved auth header
 * (`x-api-key` or OAuth `Bearer`) + `anthropic-version`, mapping `data[].id`.
 * Falls back to {@link DEFAULT_ANTHROPIC_MODELS} on any failure (no key, offline,
 * non-200, empty list). Never throws.
 */
async function listAnthropicModels(
  cfg: AnthropicConfig,
  cred: CredentialResolver,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const base = (cfg.baseURL ?? ANTHROPIC_DEFAULT_BASE_URL).replace(/\/$/, "");
  try {
    const auth = await resolveAuthHeaders(cfg, cred);
    // No credential resolvable → don't even try the network; use the fallback.
    if (Object.keys(auth).length === 0) return DEFAULT_ANTHROPIC_MODELS;
    const headers: Record<string, string> = {
      "anthropic-version": ANTHROPIC_VERSION,
      ...(cfg.defaultHeaders ?? {}),
      ...auth,
    };
    const res = await fetchImpl(`${base}/v1/models?limit=1000`, {
      headers,
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return DEFAULT_ANTHROPIC_MODELS;
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const seen = new Set<string>();
    const out: ModelInfo[] = [];
    for (const row of body.data ?? []) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, modalities: ["text", "image"] });
    }
    return out.length > 0 ? out : DEFAULT_ANTHROPIC_MODELS;
  } catch {
    return DEFAULT_ANTHROPIC_MODELS;
  }
}

// ── Adapter factory ──────────────────────────────────────────────────────────────

/**
 * Create the native Anthropic {@link ProviderAdapter}. `cred` is called lazily
 * on first use; the underlying SDK client is created once and reused.
 */
export function createAnthropicAdapter(
  cfg: AnthropicConfig,
  cred: CredentialResolver,
): ProviderAdapter {
  const transport: TransportKind = "http-sdk";
  const modelCache = createModelListCache();
  // Cache the SDK client KEYED on the resolved credential kind+value. An OAuth
  // Bearer is auto-refreshed by @nexuscode/auth mid-session (a long-running
  // `agent`/`tui`); the resolver returns the new token while the SDK client
  // bakes the Bearer in at construction. So we MUST re-resolve the credential
  // on every call and rebuild the client whenever the token value changes —
  // otherwise a rotated token would keep sending the stale (expired) Bearer and
  // 401. The shared keep-alive httpAgent is reused across rebuilds, so
  // connection pooling (§23) is preserved even when the client is recreated.
  let client: Anthropic | undefined;
  let clientCredKey: string | undefined;
  // Tracks the kind of the last resolved credential so `stream()` knows whether
  // to inject the Claude Code identity system block (required for OAuth bearer).
  let lastCredKind: AnthropicResolvedCredential["kind"] = "api-key";

  const getClient = async (): Promise<Anthropic> => {
    // Prefer the OAuth-aware credential source when wired (sends an
    // auto-refreshed Bearer token); otherwise the legacy api-key resolver.
    const resolved: AnthropicResolvedCredential = cfg.credential
      ? await cfg.credential()
      : { kind: "api-key", value: await cred() };
    lastCredKind = resolved.kind;
    // Key on kind+value: a refreshed OAuth token (new value) or a switch
    // between bearer/api-key invalidates the cached client. The value is used
    // only as an in-process cache key and is NEVER logged.
    const credKey = `${resolved.kind}:${resolved.value}`;
    if (!client || clientCredKey !== credKey) {
      const opts = buildAnthropicClientOptions(cfg, resolved);
      // Connection pooling (§23): reuse a process-wide keep-alive agent so the
      // TCP+TLS handshake is amortized and sockets are pooled across calls
      // (and across client rebuilds after a token refresh).
      opts.httpAgent = cfg.httpAgent ?? sharedAgentFor(cfg.baseURL);
      client = new Anthropic(opts);
      clientCredKey = credKey;
    }
    return client;
  };

  const capabilities = async (): Promise<Capabilities> => ({
    models: buildModelInfos(cfg.modelMap),
    streaming: true,
    tools: true,
    parallelToolCalls: true,
    vision: true,
    // Anthropic Messages accepts image input but not audio input, and exposes no
    // embeddings endpoint — declared explicitly so the router never mis-selects it.
    audio: false,
    embeddings: false,
    structuredOutput: false,
    reasoning: true,
    systemPrompt: true,
    fileEdit: false,
    shellExec: false,
    git: false,
    approvalGate: false,
    mcp: true,
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

    let ms: ReturnType<Anthropic.Messages["stream"]>;
    try {
      const anthropic = await getClient();
      ms = anthropic.messages.stream(toNativeRequest(cfg, req, lastCredKind === "bearer"), {
        signal: ctx.signal,
      });
    } catch (e) {
      const error = ctx.signal.aborted
        ? new AdapterError("cancelled", "aborted", { providerId: PROVIDER_ID })
        : mapError(e);
      yield { type: "error", runId, error, retryable: error.retryable };
      return;
    }

    const openTools: string[] = [];
    try {
      for await (const ev of ms) {
        if (ev.type === "content_block_start") {
          const block = ev.content_block as WidenedBlock;
          if (block.type === "tool_use") {
            const id = block.id ?? "";
            openTools.push(id);
            yield { type: "tool-call-start", runId, id, name: block.name ?? "", raw: ev };
          }
        } else if (ev.type === "content_block_delta") {
          const delta = ev.delta as unknown as WidenedDelta;
          if (delta.type === "text_delta") {
            yield { type: "text-delta", runId, text: delta.text ?? "", channel: "answer", raw: ev };
          } else if (delta.type === "thinking_delta") {
            yield { type: "reasoning-delta", runId, text: delta.thinking ?? "", raw: ev };
          } else if (delta.type === "input_json_delta") {
            const id = openTools[openTools.length - 1];
            if (id !== undefined) {
              yield {
                type: "tool-call-delta",
                runId,
                id,
                argsJsonDelta: delta.partial_json ?? "",
                raw: ev,
              };
            }
          }
        }
      }

      const final = await ms.finalMessage();
      const usage = mapUsage(final.usage as unknown as WidenedUsage);
      yield { type: "usage", runId, usage, raw: final.usage };
      yield {
        type: "run-end",
        runId,
        finishReason: mapStop(final.stop_reason),
        message: fromNative(final),
        usage,
        ts: Date.now(),
      };
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
      throw new AdapterError("empty_output", "Anthropic adapter produced no output.", {
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
    return { ok: true, detail: "Anthropic client ready (key resolved)" };
  };

  const listModels = (ctx?: CallContext): Promise<ModelInfo[]> =>
    modelCache.get(() => listAnthropicModels(cfg, cred, ctx?.signal));

  const dispose = async (): Promise<void> => {
    client = undefined;
    clientCredKey = undefined;
  };

  return {
    id: PROVIDER_ID,
    label: "Anthropic Claude",
    transport,
    capabilities,
    chat,
    stream,
    listModels,
    health,
    dispose,
  };
}
