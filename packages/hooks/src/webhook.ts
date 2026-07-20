/**
 * The `WebhookDispatcher` — outbound event delivery (system-spec §24). On a
 * subscribed event it POSTs a JSON envelope to each configured URL. Four
 * non-negotiable safety properties:
 *
 *   1. SSRF-GUARDED — the target URL is checked with the SAME `assertAllowedUrl`
 *      the fetch/browser tools use (private/loopback/link-local + DNS-rebinding
 *      blocked) BEFORE any request. A blocked URL is skipped, never dialed.
 *   2. SECRET-REDACTED — the payload is deep-redacted (`redactArgs`) so a
 *      credential in tool args / context never leaves the process in a webhook.
 *   3. SIGNED — when a shared secret is configured (resolved from the
 *      `SecretStore` via `secretRef`, never inlined) the body is HMAC-SHA256
 *      signed and sent as `X-NexusCode-Signature: sha256=<hex>`, so the receiver
 *      can authenticate the delivery. The secret itself is never in the payload.
 *   4. BOUNDED — each attempt has a wall-clock timeout; transient failures
 *      (network error / non-2xx) retry with exponential backoff up to
 *      `maxRetries`.
 */

import { createHmac } from "node:crypto";
import { randomUUID } from "node:crypto";
import { assertAllowedUrl, BlockedUrlError, redactArgs, type SsrfOptions } from "@nexuscode/tools";
import type { SecretStore } from "@nexuscode/config";
import type { WebhookConfig } from "@nexuscode/config";
import type { HookEvent, HookLogger } from "./types.js";

/**
 * Redirect hops a webhook delivery follows before giving up. Mirrors
 * `packages/tools-web/src/http.ts`'s `MAX_REDIRECTS`: we follow redirects
 * OURSELVES (`redirect: "manual"`) and re-run `assertAllowedUrl` on every
 * `Location`, because the underlying `fetch` layer applies NO SSRF policy to
 * intermediate hops — a permitted public webhook URL could 30x-bounce to
 * `http://169.254.169.254/` (cloud metadata) or an internal address.
 */
export const MAX_WEBHOOK_REDIRECTS = 5;

export const SIGNATURE_HEADER = "x-nexuscode-signature";
export const EVENT_HEADER = "x-nexuscode-event";
export const DELIVERY_HEADER = "x-nexuscode-delivery";
export const TIMESTAMP_HEADER = "x-nexuscode-timestamp";

/** Minimal fetch shape (so tests can inject a stub, and Node's global fits). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
    /** Always `"manual"` — see {@link MAX_WEBHOOK_REDIRECTS}. */
    redirect: "manual";
  },
) => Promise<{
  ok: boolean;
  status: number;
  /** Optional so existing non-redirect test stubs need not implement it. */
  headers?: { get(name: string): string | null };
}>;

export interface WebhookDispatcherOptions {
  /** Resolves a webhook's `secretRef` to the HMAC shared secret. */
  secretStore?: SecretStore;
  /** Injected fetch (defaults to the global `fetch`). */
  fetchImpl?: FetchLike;
  /** Structured logger for delivery failures. */
  logger?: HookLogger;
  /** Clock seam for deterministic timestamps/tests. */
  now?: () => number;
  /** Backoff sleep seam (tests pass a no-op to avoid real delays). */
  sleep?: (ms: number) => Promise<void>;
  /** Delivery-id generator seam. */
  deliveryId?: () => string;
}

/** The outcome of one webhook delivery attempt sequence. */
export interface WebhookDelivery {
  url: string;
  event: HookEvent;
  ok: boolean;
  /** True when the SSRF guard refused the URL (no request was made). */
  blocked: boolean;
  status?: number;
  attempts: number;
  deliveryId: string;
  error?: string;
}

/** The exact JSON envelope shape POSTed to a receiver. */
export interface WebhookEnvelope {
  event: HookEvent;
  deliveryId: string;
  timestamp: number;
  payload: unknown;
}

const DEFAULT_SLEEP = (ms: number): Promise<void> =>
  new Promise((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
  });

/** Compute the `sha256=<hex>` HMAC signature of `body` under `secret`. */
export function signBody(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export class WebhookDispatcher {
  private readonly secretStore: SecretStore | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly logger: HookLogger | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly deliveryId: () => string;

  constructor(opts: WebhookDispatcherOptions = {}) {
    this.secretStore = opts.secretStore;
    const impl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
    if (!impl) {
      throw new Error("WebhookDispatcher: no fetch implementation available (Node < 18?)");
    }
    this.fetchImpl = impl;
    this.logger = opts.logger;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? DEFAULT_SLEEP;
    this.deliveryId = opts.deliveryId ?? randomUUID;
  }

  /**
   * Deliver `event`/`payload` to every enabled webhook subscribed to `event`.
   * Deliveries run sequentially; each returns its own {@link WebhookDelivery}.
   */
  async dispatch(
    event: HookEvent,
    payload: unknown,
    webhooks: readonly WebhookConfig[],
  ): Promise<WebhookDelivery[]> {
    const targets = webhooks.filter((w) => w.enabled && w.events.includes(event));
    const out: WebhookDelivery[] = [];
    for (const w of targets) out.push(await this.deliver(event, payload, w));
    return out;
  }

  /** Deliver to one webhook (SSRF check → sign → POST with retries). */
  async deliver(
    event: HookEvent,
    payload: unknown,
    webhook: WebhookConfig,
  ): Promise<WebhookDelivery> {
    const deliveryId = this.deliveryId();

    // 1. SSRF guard — refuse private/loopback/rebinding targets before dialing.
    const ssrf: SsrfOptions = { allowPrivate: webhook.allowPrivate };
    if (webhook.ssrfAllowlist.length > 0) ssrf.allowlist = webhook.ssrfAllowlist;
    try {
      await assertAllowedUrl(webhook.url, ssrf);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.("warn", "webhook blocked by SSRF guard", { url: webhook.url, message });
      return { url: webhook.url, event, ok: false, blocked: true, attempts: 0, deliveryId, error: message };
    }

    // 2. Redact secrets from the payload, then build the signed envelope.
    const timestamp = this.now();
    const envelope: WebhookEnvelope = {
      event,
      deliveryId,
      timestamp,
      payload: redactArgs(payload),
    };
    const body = JSON.stringify(envelope);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      [EVENT_HEADER]: event,
      [DELIVERY_HEADER]: deliveryId,
      [TIMESTAMP_HEADER]: String(timestamp),
    };

    const secret = webhook.secretRef ? await this.secretStore?.get(webhook.secretRef) : null;
    if (secret) headers[SIGNATURE_HEADER] = signBody(body, secret);

    // 3. POST with timeout + exponential backoff retries.
    const maxAttempts = webhook.maxRetries + 1;
    let lastError: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), webhook.timeoutMs);
      timer.unref?.();
      try {
        const res = await this.postFollowingRedirects(webhook, ssrf, headers, body, controller.signal);
        clearTimeout(timer);
        if (res.ok) {
          return { url: webhook.url, event, ok: true, blocked: false, status: res.status, attempts: attempt, deliveryId };
        }
        lastError = `HTTP ${res.status}`;
        if (attempt >= maxAttempts) {
          return { url: webhook.url, event, ok: false, blocked: false, status: res.status, attempts: attempt, deliveryId, error: lastError };
        }
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof BlockedUrlError) {
          // A redirect resolved to a disallowed target — exactly like the
          // pre-flight guard above, refuse the delivery outright (no retry:
          // the receiver's redirect target is deterministic, not transient).
          this.logger?.("warn", "webhook redirect blocked by SSRF guard", {
            url: webhook.url,
            message: err.message,
          });
          return { url: webhook.url, event, ok: false, blocked: true, attempts: attempt, deliveryId, error: err.message };
        }
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt >= maxAttempts) {
          return { url: webhook.url, event, ok: false, blocked: false, attempts: attempt, deliveryId, error: lastError };
        }
      }
      // backoff: 2^(attempt-1) * 100ms, capped at 5s.
      await this.sleep(Math.min(2 ** (attempt - 1) * 100, 5000));
    }
    // Unreachable (loop always returns), but satisfies the type checker.
    return { url: webhook.url, event, ok: false, blocked: false, attempts: maxAttempts, deliveryId, error: lastError ?? "unknown" };
  }

  /**
   * POST once, following redirects OURSELVES (`redirect: "manual"`) so every
   * `Location` is re-checked against the SAME SSRF policy as the original URL —
   * the exact pattern `packages/tools-web/src/http.ts` uses for `web_fetch`.
   * Throws `BlockedUrlError` (propagated from `assertAllowedUrl`, or raised
   * directly for too-many-hops / a malformed `Location`) when a hop is refused;
   * the caller treats that identically to the pre-flight guard.
   */
  private async postFollowingRedirects(
    webhook: WebhookConfig,
    ssrf: SsrfOptions,
    headers: Record<string, string>,
    body: string,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; status: number }> {
    let currentUrl = webhook.url;
    for (let hop = 0; ; hop++) {
      const res = await this.fetchImpl(currentUrl, { method: "POST", headers, body, signal, redirect: "manual" });
      const isRedirect = res.status >= 300 && res.status < 400;
      const location = isRedirect ? (res.headers?.get("location") ?? null) : null;
      if (!location) return { ok: res.ok, status: res.status };
      if (hop >= MAX_WEBHOOK_REDIRECTS) {
        throw new BlockedUrlError(`too many webhook redirects (> ${MAX_WEBHOOK_REDIRECTS}) starting from ${webhook.url}`);
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        throw new BlockedUrlError(`webhook redirect to malformed location: ${location}`);
      }
      // Re-apply the FULL SSRF policy (scheme + private-IP + DNS) to every hop —
      // a redirect target gets no more trust than the original URL did.
      const allowed = await assertAllowedUrl(next.toString(), ssrf);
      currentUrl = allowed.toString();
    }
  }
}

/** Convenience constructor. */
export function createWebhookDispatcher(opts: WebhookDispatcherOptions = {}): WebhookDispatcher {
  return new WebhookDispatcher(opts);
}
