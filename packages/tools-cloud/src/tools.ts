/**
 * `cloud_list` and `cloud_describe` — vendor-agnostic, read-oriented cloud
 * Tools (system-spec §6). Each call names a `vendor` (aws | azure | gcp) and a
 * `resourceType`; the Tool dispatches to that vendor's `CloudProvider`.
 *
 * Safety invariants (the uniform tool pattern):
 *   - permission class `network` (the PermissionGate gates network access).
 *   - vendor SDKs are OPTIONAL, lazily loaded; a missing SDK or credential
 *     yields a clear `isError` ToolResult, never a crash.
 *   - a wall-clock timeout budget AND `ctx.signal` cancellation are enforced by
 *     racing every provider call against a combined AbortSignal.
 *   - result counts are capped; error text is scrubbed through `redactSecrets`
 *     so a credential can never leak into output or the audit log.
 */

import { NexusError, type ContentBlock } from "@nexuscode/shared";
import { errText, okText, redactSecrets, type Tool, type ToolContext, type ToolResult } from "@nexuscode/tools";
import { AwsCloudProvider } from "./aws.js";
import { AzureCloudProvider } from "./azure.js";
import { GcpCloudProvider } from "./gcp.js";
import type {
  CloudDescribeParams,
  CloudListParams,
  CloudProvider,
  CloudResource,
  CloudVendor,
} from "./provider.js";

/** Default wall-clock budget for a single cloud operation. */
export const DEFAULT_CLOUD_TIMEOUT_MS = 30_000;
/** Default page size for `cloud_list`. */
export const DEFAULT_MAX_ITEMS = 100;
/** Hard ceiling on returned resources regardless of the requested `maxItems`. */
export const HARD_MAX_ITEMS = 1000;

const VENDORS: readonly CloudVendor[] = ["aws", "azure", "gcp"] as const;

/** A fully-populated provider set, one entry per vendor. */
export type CloudProviderRegistry = Record<CloudVendor, CloudProvider>;

export interface CloudToolsOptions {
  /** Override any vendor's provider (used to inject fakes in tests). */
  providers?: Partial<CloudProviderRegistry>;
  /** Wall-clock budget per operation (default {@link DEFAULT_CLOUD_TIMEOUT_MS}). */
  timeoutMs?: number;
}

function buildRegistry(opts: CloudToolsOptions): CloudProviderRegistry {
  return {
    aws: opts.providers?.aws ?? new AwsCloudProvider(),
    azure: opts.providers?.azure ?? new AzureCloudProvider(),
    gcp: opts.providers?.gcp ?? new GcpCloudProvider(),
  };
}

// --- input validation ------------------------------------------------------

function fail(msg: string): never {
  throw new NexusError("invalid_argument", msg);
}

function asObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("expected an object argument");
  }
  return input as Record<string, unknown>;
}

function reqString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) fail(`"${key}" must be a non-empty string`);
  return v;
}

function optString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") fail(`"${key}" must be a string`);
  return v;
}

function optNumber(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) fail(`"${key}" must be a finite number`);
  return v;
}

function reqVendor(o: Record<string, unknown>): CloudVendor {
  const v = reqString(o, "vendor").toLowerCase();
  if (!VENDORS.includes(v as CloudVendor)) {
    fail(`"vendor" must be one of: ${VENDORS.join(", ")}`);
  }
  return v as CloudVendor;
}

function clampMaxItems(n: number | undefined): number {
  if (n === undefined) return DEFAULT_MAX_ITEMS;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > HARD_MAX_ITEMS) return HARD_MAX_ITEMS;
  return i;
}

interface ParsedList {
  vendor: CloudVendor;
  params: CloudListParams;
}

function parseListInput(input: unknown): ParsedList {
  const o = asObject(input);
  const vendor = reqVendor(o);
  const resourceType = reqString(o, "resourceType");
  const region = optString(o, "region");
  const params: CloudListParams = { resourceType, maxItems: clampMaxItems(optNumber(o, "maxItems")) };
  if (region !== undefined) params.region = region;
  return { vendor, params };
}

interface ParsedDescribe {
  vendor: CloudVendor;
  params: CloudDescribeParams;
}

function parseDescribeInput(input: unknown): ParsedDescribe {
  const o = asObject(input);
  const vendor = reqVendor(o);
  const resourceType = reqString(o, "resourceType");
  const id = reqString(o, "id");
  const region = optString(o, "region");
  const params: CloudDescribeParams = { resourceType, id };
  if (region !== undefined) params.region = region;
  return { vendor, params };
}

// --- timeout + cancellation budget -----------------------------------------

/**
 * Run `fn` with a combined abort signal (caller cancellation ∪ a fresh timeout).
 * We also race a rejection off that signal so a provider that ignores its
 * `signal` still cannot outrun the budget.
 */
async function withBudget<T>(
  ctx: ToolContext,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout]);
  const guard = new Promise<never>((_, reject) => {
    const onAbort = (): void => {
      reject(ctx.signal.aborted ? new Error("cancelled") : new Error(`timed out after ${timeoutMs}ms`));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return await Promise.race([fn(signal), guard]);
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw);
}

function jsonBlockText(value: unknown): string {
  return redactSecrets(JSON.stringify(value, null, 2));
}

// --- the Tools -------------------------------------------------------------

const LIST_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    vendor: { type: "string", enum: [...VENDORS], description: "Cloud vendor to query." },
    resourceType: {
      type: "string",
      description: "Vendor resource family, e.g. `s3` (aws), `storage` (azure), `gcs` (gcp).",
    },
    region: { type: "string", description: "Optional region/location scope." },
    maxItems: {
      type: "number",
      description: `Maximum resources to return (default ${DEFAULT_MAX_ITEMS}, hard cap ${HARD_MAX_ITEMS}).`,
    },
  },
  required: ["vendor", "resourceType"],
  additionalProperties: false,
};

const DESCRIBE_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    vendor: { type: "string", enum: [...VENDORS], description: "Cloud vendor to query." },
    resourceType: { type: "string", description: "Vendor resource family (see cloud_list)." },
    id: { type: "string", description: "Identifier of the resource to describe (e.g. bucket name)." },
    region: { type: "string", description: "Optional region/location scope." },
  },
  required: ["vendor", "resourceType", "id"],
  additionalProperties: false,
};

function makeCloudListTool(registry: CloudProviderRegistry, timeoutMs: number): Tool {
  return {
    name: "cloud_list",
    description:
      "List read-oriented cloud resources for a vendor (aws|azure|gcp), e.g. S3 buckets, Azure storage accounts, GCS buckets. Requires vendor SDK + credentials.",
    permission: "network",
    timeoutMs,
    parameters: LIST_SCHEMA,
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { vendor, params } = parseListInput(input);
      const provider = registry[vendor];
      const avail = await provider.detect();
      if (!avail.available) {
        return errText(redactSecrets(`cloud_list: ${vendor} unavailable — ${avail.reason ?? "not configured"}`));
      }
      try {
        const resources = await withBudget(ctx, timeoutMs, (signal) =>
          provider.list(params, { signal }),
        );
        const capped = resources.slice(0, params.maxItems);
        const block: ContentBlock = {
          type: "text",
          text: jsonBlockText({
            vendor,
            resourceType: params.resourceType,
            count: capped.length,
            resources: capped satisfies CloudResource[],
          }),
        };
        return { ok: true, content: [block] };
      } catch (err) {
        return errText(`cloud_list: ${vendor} ${params.resourceType} failed — ${messageOf(err)}`);
      }
    },
  };
}

function makeCloudDescribeTool(registry: CloudProviderRegistry, timeoutMs: number): Tool {
  return {
    name: "cloud_describe",
    description:
      "Describe a single read-oriented cloud resource for a vendor (aws|azure|gcp) by id. Requires vendor SDK + credentials.",
    permission: "network",
    timeoutMs,
    parameters: DESCRIBE_SCHEMA,
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { vendor, params } = parseDescribeInput(input);
      const provider = registry[vendor];
      const avail = await provider.detect();
      if (!avail.available) {
        return errText(redactSecrets(`cloud_describe: ${vendor} unavailable — ${avail.reason ?? "not configured"}`));
      }
      try {
        const resource = await withBudget(ctx, timeoutMs, (signal) =>
          provider.describe(params, { signal }),
        );
        if (resource === null) {
          return errText(`cloud_describe: ${vendor} ${params.resourceType} "${params.id}" not found`);
        }
        return okText(jsonBlockText(resource));
      } catch (err) {
        return errText(`cloud_describe: ${vendor} ${params.resourceType} "${params.id}" failed — ${messageOf(err)}`);
      }
    },
  };
}

/**
 * Factory: build the cloud tool group. Returns `[cloud_list, cloud_describe]`
 * ready to register in a ToolRegistry. Pass `providers` to inject fakes/mocks.
 */
export function createCloudTools(opts: CloudToolsOptions = {}): Tool[] {
  const registry = buildRegistry(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CLOUD_TIMEOUT_MS;
  return [makeCloudListTool(registry, timeoutMs), makeCloudDescribeTool(registry, timeoutMs)];
}
