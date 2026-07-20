/**
 * Error taxonomy — frozen contract.
 *
 * `AdapterError` is the normalized failure every provider adapter must map its
 * backend errors onto. `NexusError` is the kernel/config-layer error for
 * everything that is not a provider transport failure. Neither ever carries a
 * secret in its message — callers redact before constructing.
 */

export type AdapterErrorCode =
  | "auth"
  | "rate_limit"
  | "overloaded"
  | "invalid_request"
  | "context_length"
  | "content_filter"
  | "cancelled"
  | "transport"
  | "cli_exit"
  | "parse"
  | "empty_output"
  | "unknown";

export interface AdapterErrorOptions {
  /** Force retryability on/off; when omitted a code-based default is used. */
  retryable?: boolean;
  /** Milliseconds the backend asked us to wait (parsed from `Retry-After`). */
  retryAfterMs?: number;
  /** Originating HTTP status, when the transport was HTTP. */
  httpStatus?: number;
  /** Subprocess exit code, when the transport was a CLI. */
  exitCode?: number | null;
  /** The provider id that produced the error. */
  providerId?: string;
  /** Underlying error/object for debugging (never serialized to history). */
  cause?: unknown;
}

/** Codes that retry by default (transient / server-side). */
const DEFAULT_RETRYABLE: readonly AdapterErrorCode[] = ["rate_limit", "overloaded", "transport"];

/** Shape safe to persist to the event log (no `cause`, no secrets). */
export interface SerializedAdapterError {
  name: "AdapterError";
  code: AdapterErrorCode;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  exitCode?: number | null;
  providerId?: string;
  retryAfterMs?: number;
}

export class AdapterError extends Error {
  override readonly name = "AdapterError";
  readonly code: AdapterErrorCode;
  readonly opts: AdapterErrorOptions;

  constructor(code: AdapterErrorCode, message: string, opts: AdapterErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.code = code;
    this.opts = opts;
  }

  get retryable(): boolean {
    return this.opts.retryable ?? DEFAULT_RETRYABLE.includes(this.code);
  }

  /** JSON-safe projection, used by the history logger. Drops `cause`. */
  toJSON(): SerializedAdapterError {
    const out: SerializedAdapterError = {
      name: "AdapterError",
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
    if (this.opts.httpStatus !== undefined) out.httpStatus = this.opts.httpStatus;
    if (this.opts.exitCode !== undefined) out.exitCode = this.opts.exitCode;
    if (this.opts.providerId !== undefined) out.providerId = this.opts.providerId;
    if (this.opts.retryAfterMs !== undefined) out.retryAfterMs = this.opts.retryAfterMs;
    return out;
  }
}

export type NexusErrorCode =
  | "config_invalid"
  | "config_not_found"
  | "provider_not_found"
  | "model_not_found"
  | "duplicate_provider"
  | "not_implemented"
  | "secret_not_found"
  | "secret_backend"
  | "invalid_argument"
  | "internal";

export interface NexusErrorOptions {
  cause?: unknown;
  /** Optional machine-readable detail bag (never contains secrets). */
  detail?: Record<string, unknown>;
}

export class NexusError extends Error {
  override readonly name = "NexusError";
  readonly code: NexusErrorCode;
  readonly detail: Record<string, unknown> | undefined;

  constructor(code: NexusErrorCode, message: string, opts: NexusErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.code = code;
    this.detail = opts.detail;
  }
}

export function isAdapterError(e: unknown): e is AdapterError {
  return e instanceof AdapterError;
}

export function isNexusError(e: unknown): e is NexusError {
  return e instanceof NexusError;
}
