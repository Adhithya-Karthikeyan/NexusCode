/**
 * @nexuscode/hooks — lifecycle hooks + outbound webhooks (system-spec §24
 * Extensibility). Two seams the harness (CLI / SDK / REST daemon) fires around
 * the engine without the engine ever depending on either:
 *
 *   - `HookBus`             ordered, async, error-isolated lifecycle hooks with
 *                           pre- veto/modify (in-process + command hooks).
 *   - `WebhookDispatcher`   HMAC-signed, secret-redacted, SSRF-guarded outbound
 *                           POSTs with timeout + backoff retries.
 *
 * Config shapes (`HooksConfig`, `CommandHookConfig`, `WebhookConfig`) live in
 * `@nexuscode/config`'s cascade and are re-exported here for convenience.
 */

export * from "./types.js";
export { HookBus, createHookBus, type HookBusOptions } from "./bus.js";
export {
  runCommandHook,
  resultToVerdict,
  commandHookHandler,
  registerCommandHooks,
  type CommandHookResult,
} from "./command.js";
export {
  WebhookDispatcher,
  createWebhookDispatcher,
  signBody,
  SIGNATURE_HEADER,
  EVENT_HEADER,
  DELIVERY_HEADER,
  TIMESTAMP_HEADER,
  MAX_WEBHOOK_REDIRECTS,
  type FetchLike,
  type WebhookDispatcherOptions,
  type WebhookDelivery,
  type WebhookEnvelope,
} from "./webhook.js";

export type {
  HooksConfig,
  CommandHookConfig,
  WebhookConfig,
  HookEventName,
} from "@nexuscode/config";
