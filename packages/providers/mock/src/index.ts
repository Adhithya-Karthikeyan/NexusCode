/**
 * @nexuscode/provider-mock — a deterministic, fully offline `ProviderAdapter`.
 *
 * It needs no network and no API keys, which makes it the backbone of the test
 * and `doctor`/verify pipeline: the entire streaming loop (run-start → text
 * deltas → usage → run-end), cancellation, and non-streaming buffering can all
 * be exercised end-to-end without touching a real provider.
 *
 * The output is derived deterministically from the prompt (an echo/transform),
 * so the same request always yields the same content. Two virtual models are
 * provided — `mock-fast` (terse echo) and `mock-smart` (a longer, "considered"
 * reply) — and an artificial per-chunk delay can be configured to simulate
 * streaming latency (and to give tests a window in which to abort).
 */

import type {
  AdapterErrorCode,
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
  Message,
  ModelInfo,
  StreamChunk,
  Usage,
} from "@nexuscode/shared";
import { AdapterError } from "@nexuscode/shared";

/** Options for {@link createMockAdapter}. All are optional with sane defaults. */
export interface MockAdapterOptions {
  /** Adapter id. Default `"mock"`. */
  id?: string;
  /** Human label for the TUI. Default `"Mock (offline)"`. */
  label?: string;
  /** Virtual models this adapter advertises. Default `["mock-fast","mock-smart"]`. */
  models?: string[];
  /** Artificial delay in ms inserted before each streamed text delta. Default `0`. */
  delayMs?: number;
  /**
   * Deterministic prompt → answer transform. Overriding it lets tests script
   * exact output. The default echoes the prompt, varying tone by model.
   */
  transform?: (prompt: string, model: string) => string;
  /**
   * Name of the tool the `mock-tools` model calls on its first turn. Default
   * `"fs_read"` — a built-in tool, so the agentic loop is exercisable offline
   * against a real tool with no network.
   */
  toolName?: string;
  /**
   * Deterministic prompt → tool-input transform for the `mock-tools` model.
   * Default `(p) => ({ path: p })`, matching `fs_read`'s schema.
   */
  toolInput?: (prompt: string) => unknown;
}

const DEFAULT_MODELS = ["mock-fast", "mock-smart", "mock-tools"] as const;

/** True when a virtual model id designates the tool-calling behavior. */
function isToolModel(model: string): boolean {
  return model.includes("tool");
}

/** Rough, deterministic token estimate (~4 chars/token) for a piece of text. */
function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Pull the prompt to echo: the last user message's text, else all text joined. */
function extractPrompt(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (!msg || msg.role !== "user") continue;
    const text = textOfBlocks(msg);
    if (text.length > 0) return text;
  }
  let all = "";
  for (const msg of req.messages) all += textOfBlocks(msg);
  return all;
}

function textOfBlocks(msg: Message): string {
  let out = "";
  for (const b of msg.content) if (b.type === "text") out += b.text;
  return out;
}

/** The default deterministic transform: an echo whose tone depends on the model. */
function defaultTransform(prompt: string, model: string): string {
  const p = prompt.trim() || "(empty prompt)";
  if (model.includes("smart")) {
    return (
      `[mock-smart] Considering your request: "${p}". ` +
      `Here is a deterministic, offline reply generated without any network call. ` +
      `The same input always produces this same output.`
    );
  }
  return `[mock-fast] Echo: ${p}`;
}

/**
 * Split text into a small, deterministic set of streamed deltas (~4 chunks),
 * preserving every character so the concatenation is loss-free.
 */
function chunkText(text: string): string[] {
  if (text.length === 0) return [""];
  const words = text.match(/\S+\s*/g);
  if (!words || words.length === 0) return [text];
  const groupCount = 4;
  const size = Math.ceil(words.length / groupCount);
  const out: string[] = [];
  for (let i = 0; i < words.length; i += size) {
    out.push(words.slice(i, i + size).join(""));
  }
  return out;
}

/** A delay that resolves either after `ms` or as soon as `signal` aborts. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Concatenate the text of a message's content blocks. */
function messageText(msg: Message): string {
  let out = "";
  for (const b of msg.content) {
    if (b.type === "text") out += b.text;
    else if (b.type === "tool_result") out += blocksText(b.content);
  }
  return out;
}

function blocksText(blocks: ContentBlock[]): string {
  let out = "";
  for (const b of blocks) if (b.type === "text") out += b.text;
  return out;
}

/**
 * True when the conversation already carries the answer to the model's last
 * tool call — i.e. a `tool`-role message (or a `tool_result` block) is the most
 * recent turn. That is the signal for `mock-tools` to stop calling tools and
 * emit its final answer.
 */
function hasToolResult(req: ChatRequest): boolean {
  const last = req.messages[req.messages.length - 1];
  if (!last) return false;
  if (last.role === "tool") return true;
  return last.content.some((b) => b.type === "tool_result");
}

/** The most-recent tool result's text, for the final answer to reference. */
function lastToolResultText(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const msg = req.messages[i];
    if (!msg) continue;
    if (msg.role === "tool") return messageText(msg);
    const block = msg.content.find((b) => b.type === "tool_result");
    if (block && block.type === "tool_result") return blocksText(block.content);
  }
  return "";
}

/** Build the terminal cancellation error chunk. */
function cancelledChunk(runId: string, providerId: string): StreamChunk {
  const error = new AdapterError("cancelled", "Mock run cancelled by caller.", {
    providerId,
    retryable: false,
  });
  return { type: "error", runId, error, retryable: false };
}

/**
 * Create a deterministic, offline mock adapter. The returned object satisfies
 * the frozen `ProviderAdapter` contract and can be registered like any real
 * provider.
 */
export function createMockAdapter(opts: MockAdapterOptions = {}): ProviderAdapter {
  const id = opts.id ?? "mock";
  const label = opts.label ?? "Mock (offline)";
  const transport: TransportKind = "http-sdk";
  const models = opts.models && opts.models.length > 0 ? [...opts.models] : [...DEFAULT_MODELS];
  const delayMs = opts.delayMs ?? 0;
  const transform = opts.transform ?? defaultTransform;
  const toolName = opts.toolName ?? "fs_read";
  const toolInput = opts.toolInput ?? ((prompt: string): unknown => ({ path: prompt }));
  const defaultModel = models[0] ?? "mock-fast";
  const supportsTools = models.some((m) => isToolModel(m));

  const modelInfos = (): ModelInfo[] =>
    models.map((m) => ({
      id: m,
      contextWindow: 32_000,
      maxOutput: 4_096,
      modalities: ["text"] as ("text" | "image" | "audio")[],
    }));

  const capabilities = async (): Promise<Capabilities> => {
    return {
      models: modelInfos(),
      streaming: true,
      tools: supportsTools,
      parallelToolCalls: false,
      vision: false,
      structuredOutput: false,
      reasoning: false,
      systemPrompt: true,
      fileEdit: false,
      shellExec: false,
      git: false,
      approvalGate: false,
      mcp: false,
      cancel: "abort-signal",
    };
  };

  async function* stream(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamChunk> {
    const runId = ctx.runId;
    const model = req.model || defaultModel;

    yield { type: "run-start", runId, adapterId: id, model, ts: Date.now() };

    if (ctx.signal.aborted) {
      yield cancelledChunk(runId, id);
      return;
    }

    // Tool-calling model: on the first turn emit a single native tool call and
    // finish with `tool_use`; once a tool result has been fed back, emit the
    // final answer. This exercises the whole agentic loop deterministically and
    // offline (no network, no keys).
    if (isToolModel(model)) {
      const prompt = extractPrompt(req);
      if (!hasToolResult(req)) {
        const input = toolInput(prompt);
        const callId = `call_${id}_${req.messages.length}`;
        const argsJson = JSON.stringify(input);
        yield { type: "tool-call-start", runId, id: callId, name: toolName };
        yield { type: "tool-call-delta", runId, id: callId, argsJsonDelta: argsJson };
        yield { type: "tool-call-end", runId, id: callId, input };
        const usage: Usage = {
          inputTokens: estimateTokens(prompt),
          outputTokens: estimateTokens(argsJson),
          costUsd: 0,
        };
        yield { type: "usage", runId, usage };
        const message: Message = {
          role: "assistant",
          content: [{ type: "tool_use", id: callId, name: toolName, input }],
        };
        yield { type: "run-end", runId, finishReason: "tool_use", message, usage, ts: Date.now() };
        return;
      }

      const resultText = lastToolResultText(req).trim();
      const answer =
        `[mock-tools] Used ${toolName} and received: ${resultText || "(empty)"}. ` +
        `Final answer for "${prompt.trim() || "(empty prompt)"}".`;
      const parts = chunkText(answer);
      let assembled = "";
      for (const part of parts) {
        await abortableDelay(delayMs, ctx.signal);
        if (ctx.signal.aborted) {
          yield cancelledChunk(runId, id);
          return;
        }
        assembled += part;
        yield { type: "text-delta", runId, text: part, channel: "answer" };
      }
      const usage: Usage = {
        inputTokens: estimateTokens(resultText),
        outputTokens: estimateTokens(answer),
        costUsd: 0,
      };
      yield { type: "usage", runId, usage };
      const message: Message = { role: "assistant", content: [{ type: "text", text: assembled }] };
      yield { type: "run-end", runId, finishReason: "stop", message, usage, ts: Date.now() };
      return;
    }

    const prompt = extractPrompt(req);
    const answer = transform(prompt, model);
    const parts = chunkText(answer);

    let assembled = "";
    for (const part of parts) {
      await abortableDelay(delayMs, ctx.signal);
      if (ctx.signal.aborted) {
        yield cancelledChunk(runId, id);
        return;
      }
      assembled += part;
      yield { type: "text-delta", runId, text: part, channel: "answer" };
    }

    const usage: Usage = {
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(answer),
      costUsd: 0,
    };
    yield { type: "usage", runId, usage };

    const message: Message = {
      role: "assistant",
      content: [{ type: "text", text: assembled }],
    };
    yield {
      type: "run-end",
      runId,
      finishReason: "stop",
      message,
      usage,
      ts: Date.now(),
    };
  }

  async function chat(req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
    let message: Message | undefined;
    let usage: Usage | undefined;
    let finishReason: ChatResult["finishReason"] = "stop";

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
      throw new AdapterError("empty_output", "Mock adapter produced no output.", {
        providerId: id,
      });
    }

    const result: ChatResult = { message, finishReason };
    if (usage) result.usage = usage;
    return result;
  }

  const health = async (_ctx: CallContext): Promise<HealthStatus> => ({
    ok: true,
    detail: "mock adapter ready (offline, no network, no keys)",
  });

  /** Deterministic, offline model discovery: this mock's own virtual models. */
  const listModels = async (): Promise<ModelInfo[]> => modelInfos();

  return {
    id,
    label,
    transport,
    capabilities,
    chat,
    stream,
    listModels,
    health,
  };
}

/** A ready-to-use default instance (`mock-fast` + `mock-smart`, no delay). */
export const mockAdapter: ProviderAdapter = createMockAdapter();

// ── mock-flaky — fails-then-succeeds (failover / retry tests) ─────────────────────

/** Options for {@link createFlakyMockAdapter}. */
export interface FlakyMockOptions extends MockAdapterOptions {
  /**
   * Number of leading attempts that fail before the adapter starts succeeding.
   * Default `1`. Set to `Infinity` for a provider that always fails.
   */
  failCount?: number;
  /**
   * The {@link AdapterErrorCode} of the induced failure. Default `"overloaded"`,
   * a retryable code so `withRetry`/failover paths will re-attempt.
   */
  failCode?: AdapterErrorCode;
  /**
   * Whether the induced failure is retryable. Default `true` — the point of this
   * provider is to exercise retry/failover, which requires a retryable error.
   */
  retryable?: boolean;
}

/**
 * A deterministic, offline provider that fails its first `failCount` attempts
 * with a retryable error, then behaves exactly like {@link createMockAdapter}.
 *
 * The attempt counter lives on the adapter instance and is shared by `chat` and
 * `stream`, so a single instance handed to the core `withRetry`/failover loop
 * will fail-then-succeed across successive attempts. Fresh instances reset the
 * counter, keeping tests isolated. No network, no keys, fully reproducible.
 */
export function createFlakyMockAdapter(opts: FlakyMockOptions = {}): ProviderAdapter {
  const { failCount = 1, failCode = "overloaded", retryable = true, ...mockOpts } = opts;
  const id = opts.id ?? "mock-flaky";
  const label = opts.label ?? "Mock Flaky (offline)";
  const base = createMockAdapter({ ...mockOpts, id, label });
  const defaultModel = (opts.models && opts.models[0]) ?? "mock-fast";
  let attempts = 0;

  async function* stream(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamChunk> {
    const attempt = ++attempts;
    if (attempt <= failCount) {
      const model = req.model || defaultModel;
      yield { type: "run-start", runId: ctx.runId, adapterId: id, model, ts: Date.now() };
      const error = new AdapterError(
        failCode,
        `mock-flaky induced failure ${attempt}/${failCount === Infinity ? "∞" : failCount}`,
        { providerId: id, retryable },
      );
      yield { type: "error", runId: ctx.runId, error, retryable };
      return;
    }
    yield* base.stream(req, ctx);
  }

  async function chat(req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
    let message: Message | undefined;
    let usage: Usage | undefined;
    let finishReason: ChatResult["finishReason"] = "stop";
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
      throw new AdapterError("empty_output", "Mock flaky adapter produced no output.", {
        providerId: id,
      });
    }
    const result: ChatResult = { message, finishReason };
    if (usage) result.usage = usage;
    return result;
  }

  const health = async (_ctx: CallContext): Promise<HealthStatus> => ({
    ok: true,
    detail: "mock-flaky adapter ready (offline, no network, no keys)",
  });

  return {
    id,
    label,
    transport: "http-sdk",
    capabilities: base.capabilities,
    chat,
    stream,
    ...(base.listModels ? { listModels: base.listModels } : {}),
    health,
  };
}

// ── mock-slow — configurable latency (race / latency tests) ───────────────────────

/** Options for {@link createSlowMockAdapter}. */
export interface SlowMockOptions extends MockAdapterOptions {
  /**
   * Abortable delay (ms) inserted before the very first chunk — the adapter's
   * time-to-first-token. Default `50`. This is in addition to any per-chunk
   * {@link MockAdapterOptions.delayMs}. Use it to make one racer deterministically
   * slower than another.
   */
  startupDelayMs?: number;
}

/**
 * A deterministic, offline provider that pauses `startupDelayMs` before emitting
 * any content, then streams like {@link createMockAdapter}. Ideal as the "loser"
 * in a race primitive or for latency assertions. The delay honors `ctx.signal`,
 * so aborting during the pause yields a terminal `cancelled` error and no output.
 */
export function createSlowMockAdapter(opts: SlowMockOptions = {}): ProviderAdapter {
  const { startupDelayMs = 50, ...mockOpts } = opts;
  const id = opts.id ?? "mock-slow";
  const label = opts.label ?? "Mock Slow (offline)";
  const base = createMockAdapter({ ...mockOpts, id, label });

  async function* stream(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamChunk> {
    if (ctx.signal.aborted) {
      yield cancelledChunk(ctx.runId, id);
      return;
    }
    await abortableDelay(startupDelayMs, ctx.signal);
    if (ctx.signal.aborted) {
      yield cancelledChunk(ctx.runId, id);
      return;
    }
    yield* base.stream(req, ctx);
  }

  async function chat(req: ChatRequest, ctx: CallContext): Promise<ChatResult> {
    let message: Message | undefined;
    let usage: Usage | undefined;
    let finishReason: ChatResult["finishReason"] = "stop";
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
      throw new AdapterError("empty_output", "Mock slow adapter produced no output.", {
        providerId: id,
      });
    }
    const result: ChatResult = { message, finishReason };
    if (usage) result.usage = usage;
    return result;
  }

  const health = async (_ctx: CallContext): Promise<HealthStatus> => ({
    ok: true,
    detail: "mock-slow adapter ready (offline, no network, no keys)",
  });

  return {
    id,
    label,
    transport: "http-sdk",
    capabilities: base.capabilities,
    chat,
    stream,
    ...(base.listModels ? { listModels: base.listModels } : {}),
    health,
  };
}
