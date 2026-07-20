/**
 * The CloudProvider seam (system-spec §6 — Cloud tools).
 *
 * Every vendor (AWS / Azure / GCP) implements the same tiny read-oriented
 * contract: `detect()` feature-detects both the credentials AND the vendor SDK,
 * `list()` enumerates resources, and `describe()` returns one resource's detail.
 * The two Tools (`cloud_list`, `cloud_describe`) are vendor-agnostic — they
 * dispatch to the provider named by the call's `vendor` argument.
 *
 * The vendor SDKs (`@aws-sdk/*`, `@azure/*`, `@google-cloud/*`) are OPTIONAL,
 * LAZILY-loaded dependencies: never hard deps, imported via `tryImport` and
 * feature-detected at call time. When a SDK (or a credential signal) is absent,
 * `detect()` returns `available: false` with a clear, install-/config-hint
 * reason and the Tool surfaces a non-crashing `isError` ToolResult.
 *
 * Nothing here ever reads a credential's *value* — only the *presence* of the
 * relevant environment variables — so no secret can leak through this seam.
 */

export type CloudVendor = "aws" | "azure" | "gcp";

/** A normalized, vendor-agnostic view of a cloud resource. */
export interface CloudResource {
  /** Stable identifier within its vendor/type (e.g. an S3 bucket name). */
  id: string;
  /** Human-friendly name. */
  name: string;
  /** Namespaced resource type, e.g. `s3:bucket`, `storage:account`, `gcs:bucket`. */
  type: string;
  /** Owning vendor. */
  vendor: CloudVendor;
  /** Region/location when known. */
  region?: string;
  /** ISO-8601 creation timestamp when known. */
  createdAt?: string;
  /** Extra, non-secret vendor detail. */
  metadata?: Record<string, unknown>;
}

/** Arguments to a `list` call, already validated and clamped by the Tool. */
export interface CloudListParams {
  /** Vendor-specific resource family, e.g. `s3`, `storage`, `gcs`. */
  resourceType: string;
  /** Optional region/location scope. */
  region?: string;
  /** Maximum resources to return (already clamped to the hard cap). */
  maxItems: number;
}

/** Arguments to a `describe` call. */
export interface CloudDescribeParams {
  resourceType: string;
  /** Identifier of the resource to describe (e.g. bucket name). */
  id: string;
  region?: string;
}

/** Result of feature-detecting a provider's SDK + credentials. */
export interface CloudAvailability {
  available: boolean;
  /** When unavailable: a clear, secret-free hint (install cmd or config step). */
  reason?: string;
}

/** Per-call knobs: a combined abort signal (cancellation ∪ timeout budget). */
export interface CloudCallOptions {
  signal: AbortSignal;
}

/** The vendor seam every cloud provider implements. */
export interface CloudProvider {
  readonly vendor: CloudVendor;
  /** Feature-detect creds + SDK. Cheap; safe to call before every operation. */
  detect(): Promise<CloudAvailability>;
  /** Enumerate resources of `resourceType`. Honors `opts.signal`. */
  list(params: CloudListParams, opts: CloudCallOptions): Promise<CloudResource[]>;
  /** Describe a single resource, or `null` when it does not exist. */
  describe(params: CloudDescribeParams, opts: CloudCallOptions): Promise<CloudResource | null>;
}

/**
 * Dynamic `import()` that TypeScript will NOT try to statically resolve — the
 * indirection through `Function` keeps the optional vendor SDKs out of the
 * build graph so `npm install` stays lean and the build never fails on a
 * missing `@aws-sdk/*` / `@azure/*` / `@google-cloud/*` package.
 */
const dynamicImport = new Function("specifier", "return import(specifier);") as (
  specifier: string,
) => Promise<unknown>;

/** Attempt an optional import; resolve `undefined` (never throw) if absent. */
export async function tryImport(specifier: string): Promise<unknown | undefined> {
  try {
    return await dynamicImport(specifier);
  } catch {
    return undefined;
  }
}

/** True when at least one of the named env vars is present and non-empty. */
export function hasEnv(...names: string[]): boolean {
  return names.some((n) => {
    const v = process.env[n];
    return typeof v === "string" && v.length > 0;
  });
}

/** Build a uniform "SDK not installed" availability with an npm-install hint. */
export function notInstalled(pkg: string): CloudAvailability {
  return { available: false, reason: `${pkg} not installed (npm i ${pkg})` };
}

/** Build a uniform "no credentials" availability with a config hint. */
export function noCreds(vendor: CloudVendor, hint: string): CloudAvailability {
  return { available: false, reason: `${vendor} credentials not found (${hint})` };
}
