/**
 * Map `openai` SDK failures onto the normalized {@link AdapterError} taxonomy.
 *
 * Retries are owned centrally by `@nexuscode/core`'s `withRetry`; adapters set
 * `maxRetries: 0` on the SDK. This mapper only classifies — it decides the
 * `AdapterErrorCode` (which drives the default retryability) and surfaces
 * `Retry-After` so backoff can honor the server's hint.
 */

import {
  APIError,
  APIConnectionError,
  APIConnectionTimeoutError,
  APIUserAbortError,
} from "openai";
import { AdapterError, type AdapterErrorCode, type AdapterErrorOptions } from "@nexuscode/core";

/** Read a header value from a web `Headers` instance or a plain record. */
function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name) ?? undefined;
  }
  const rec = headers as Record<string, string | undefined>;
  return rec[name] ?? rec[name.toLowerCase()] ?? undefined;
}

/**
 * Redact secret-looking tokens from a backend error message before it becomes
 * an {@link AdapterError}'s `message`. Backends (esp. OpenAI-compatible proxies)
 * sometimes echo the offending credential verbatim in a 401/403 body (e.g.
 * "invalid api key: sk-abc123..."); that string must never reach logs/UI.
 * Matches common provider key prefixes (`sk-`, `xai-`, `gsk-`, `nvapi-`, `or-`)
 * plus any bare `Bearer <token>` header value echoed into a message.
 */
export function redactSecrets(msg: string): string {
  return msg
    .replace(/\b(sk|xai|gsk|nvapi|or)-[A-Za-z0-9_-]{6,}\b/gi, "***")
    .replace(/Bearer\s+\S+/gi, "Bearer ***");
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms. */
export function parseRetryAfterMs(headers: unknown): number | undefined {
  const raw = headerValue(headers, "retry-after");
  if (raw == null || raw === "") return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/**
 * Best-effort extraction of the backend's error message + code. OpenAI-shaped
 * bodies nest as `{ error: { message, code, type } }`; some compat backends put
 * those fields at the top level. Handle both, then fall back to the Error's own
 * message (which the SDK builds from the response for real transport errors).
 */
function bodyDetail(err: APIError): { message?: string; code?: string } {
  const out: { message?: string; code?: string } = {};
  if (typeof err.code === "string") out.code = err.code;

  const readFields = (obj: unknown): void => {
    if (!obj || typeof obj !== "object") return;
    const rec = obj as { message?: unknown; code?: unknown };
    if (out.message == null && typeof rec.message === "string") out.message = rec.message;
    if (out.code == null && typeof rec.code === "string") out.code = rec.code;
  };

  const body = err.error as { error?: unknown; message?: unknown; code?: unknown } | undefined;
  if (body && typeof body === "object") {
    readFields(body.error); // nested `{ error: { … } }`
    readFields(body); // or top-level `{ message, code }`
  }
  if (out.message == null && typeof err.message === "string") out.message = err.message;
  return out;
}

/** True when a 400/422 is really a context-window overflow, not a bad request. */
function looksLikeContextOverflow(message: string | undefined, code: string | undefined): boolean {
  if (code === "context_length_exceeded" || code === "string_above_max_length") return true;
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes("context length") ||
    m.includes("context window") ||
    m.includes("maximum context") ||
    m.includes("too many tokens") ||
    (m.includes("reduce") && m.includes("length"))
  );
}

/**
 * Classify any thrown value into an {@link AdapterError}. Idempotent: an
 * `AdapterError` (or an abort) passes through with the right code.
 */
export function mapOpenAIError(err: unknown, providerId: string): AdapterError {
  if (err instanceof AdapterError) return err;

  const base: AdapterErrorOptions = { providerId, cause: err };

  // User/library abort — never retried, mapped to `cancelled`.
  if (
    err instanceof APIUserAbortError ||
    (err instanceof Error && err.name === "AbortError")
  ) {
    return new AdapterError("cancelled", "request aborted", { ...base, retryable: false });
  }

  // Network-level failure (DNS, ECONNREFUSED, socket hang up, timeout): retryable.
  if (err instanceof APIConnectionError) {
    const isTimeout = err instanceof APIConnectionTimeoutError;
    return new AdapterError(
      "transport",
      isTimeout ? "connection timed out" : "connection error",
      { ...base, retryable: true },
    );
  }

  if (err instanceof APIError) {
    const status = err.status;
    const { message, code } = bodyDetail(err);
    const opts: AdapterErrorOptions = { ...base };
    if (typeof status === "number") opts.httpStatus = status;
    const retryAfter = parseRetryAfterMs(err.headers);
    if (retryAfter != null) opts.retryAfterMs = retryAfter;
    const msg = message ?? err.message ?? "request failed";

    let adapterCode: AdapterErrorCode;
    switch (true) {
      case status === 401 || status === 403:
        adapterCode = "auth";
        break;
      case status === 429:
        adapterCode = "rate_limit";
        break;
      case status === 400 || status === 422:
        adapterCode = looksLikeContextOverflow(message, code)
          ? "context_length"
          : code === "content_filter"
            ? "content_filter"
            : "invalid_request";
        break;
      case status === 404 || status === 409 || status === 413 || status === 415:
        adapterCode = "invalid_request";
        break;
      case status === 408:
        adapterCode = "transport";
        break;
      case status != null && status >= 500:
        // 500/502/503/529 (xAI/Anthropic-style overload) — treat as transient.
        adapterCode = "overloaded";
        break;
      default:
        adapterCode = "unknown";
    }
    return new AdapterError(adapterCode, redactSecrets(msg), opts);
  }

  if (err instanceof Error) {
    return new AdapterError("unknown", redactSecrets(err.message), base);
  }
  return new AdapterError("unknown", redactSecrets(String(err)), base);
}
