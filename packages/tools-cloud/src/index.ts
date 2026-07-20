/**
 * @nexuscode/tools-cloud — read-oriented Cloud tools (system-spec §6) for
 * NexusCode (Wave 9).
 *
 * Two vendor-agnostic Tools — `cloud_list` and `cloud_describe` — dispatch to a
 * per-vendor `CloudProvider` seam (AWS / Azure / GCP). Each vendor SDK
 * (`@aws-sdk/*`, `@azure/*`, `@google-cloud/*`) is an OPTIONAL, lazily-loaded
 * dependency, feature-detected alongside credentials at call time; a missing
 * SDK or credential yields a clear `isError` ToolResult, never a crash.
 *
 * Both Tools carry the `network` permission class, enforce a wall-clock timeout
 * plus `ctx.signal` cancellation, cap returned counts, and scrub every output
 * and error string through `redactSecrets` so no credential can leak.
 *
 * `createCloudTools()` returns the group's `Tool[]` for registration; pass
 * `providers` to inject fakes/mocks (used by the offline test suite).
 */

export {
  createCloudTools,
  DEFAULT_CLOUD_TIMEOUT_MS,
  DEFAULT_MAX_ITEMS,
  HARD_MAX_ITEMS,
  type CloudToolsOptions,
  type CloudProviderRegistry,
} from "./tools.js";

export { AwsCloudProvider } from "./aws.js";
export { AzureCloudProvider } from "./azure.js";
export { GcpCloudProvider } from "./gcp.js";

export {
  hasEnv,
  noCreds,
  notInstalled,
  tryImport,
  type CloudVendor,
  type CloudResource,
  type CloudListParams,
  type CloudDescribeParams,
  type CloudAvailability,
  type CloudCallOptions,
  type CloudProvider,
} from "./provider.js";
