/**
 * `ProviderAdapter` — frozen contract. Every backend (HTTP SDK, OpenAI-compatible
 * transport, or wrapped coding CLI) implements exactly this interface and is
 * interchangeable behind one streaming loop:
 *
 *   for await (const chunk of adapter.stream(req, ctx)) render(chunk);
 *
 * Adding a provider never edits `@nexuscode/shared` or the core kernel.
 */

import type {
  Capabilities,
  ChatRequest,
  FinishReason,
  Message,
  ModelInfo,
  StreamChunk,
  Usage,
} from "@nexuscode/shared";

export type TransportKind = "http-sdk" | "http-openai-compat" | "cli-subprocess";

/** A resolved credential handed to an adapter for one call. */
export interface ResolvedCredential {
  value: string;
  source: "env" | "keychain" | "file" | "none";
}

/** A trace event emitted through `CallContext.emit` (redacted before sinks). */
export interface TraceEvent {
  type: string;
  traceId: string;
  runId?: string;
  ts: number;
  data?: unknown;
}

export interface CallContext {
  /** Threaded to fetch/SDK AND child.kill(). */
  signal: AbortSignal;
  /** Dedupe key for at-least-once safe retries. */
  idempotencyKey: string;
  /** Correlation id on every trace event. */
  traceId: string;
  /** The Run this call belongs to (stamped onto chunks). */
  runId: string;
  /** Per-call auth override; else the adapter's resolved credential. */
  credential?: ResolvedCredential;
  /** Trace sink (no-op in tests). */
  emit?: (e: TraceEvent) => void;
}

export interface HealthStatus {
  ok: boolean;
  detail?: string;
}

export interface ChatResult {
  message: Message;
  usage?: Usage;
  finishReason: FinishReason;
}

export interface ProviderAdapter {
  /** "anthropic" | "openai" | "grok" | "ollama" | "mock" | "claude-code" | … */
  readonly id: string;
  /** Human label for the TUI. */
  readonly label: string;
  readonly transport: TransportKind;

  /** Static + probed capabilities. Called once at registration, cached. */
  capabilities(opts?: { signal?: AbortSignal }): Promise<Capabilities>;

  /** Non-streaming turn; may stream internally and buffer. */
  chat(req: ChatRequest, ctx: CallContext): Promise<ChatResult>;

  /**
   * The canonical path: yields normalized chunks until a terminal `run-end` or
   * `error`. MUST honor `ctx.signal`.
   */
  stream(req: ChatRequest, ctx: CallContext): AsyncIterable<StreamChunk>;

  /**
   * Optional embeddings endpoint. Present only on adapters whose backend exposes
   * a native embeddings API (OpenAI `/v1/embeddings`, Ollama). Returns one vector
   * per input text, index-aligned with `texts`. Additive & optional: the core
   * streaming loop never depends on it, and `@nexuscode/rag` can source real
   * provider embeddings through the registry when an adapter declares
   * `capabilities().embeddings === true` and implements this method.
   */
  embed?(texts: string[], ctx?: CallContext): Promise<number[][]>;

  /**
   * Optional real model discovery. When present, returns the list of models the
   * THIS provider actually offers — sourced live from the backend's model
   * endpoint (OpenAI-compat `GET /models`, Anthropic `/v1/models`, Gemini
   * `models.list`, Ollama `/api/tags`, …) when it can be reached, and a curated
   * static fallback otherwise.
   *
   * Additive & optional: the core kernel and TUI treat `undefined` as "use the
   * adapter's `capabilities().models`". Callers use this to populate a per-provider
   * model picker so it shows ONLY the active provider's models, never the global
   * catalog.
   *
   * MUST NOT throw and MUST NOT depend on network reachability: any failure —
   * missing credential, offline backend, no list endpoint — degrades to the
   * curated fallback (or an empty list for a local daemon that is down). The
   * result MAY be cached briefly per adapter.
   */
  listModels?(ctx?: CallContext): Promise<ModelInfo[]>;

  /** Optional cheap readiness probe: keys present, daemon up, CLI on PATH. */
  health?(ctx: CallContext): Promise<HealthStatus>;

  /** Release pooled clients / reap child processes. */
  dispose?(): Promise<void>;
}
