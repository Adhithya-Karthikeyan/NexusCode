/**
 * GCP cloud provider (read-oriented). Lazily loads `@google-cloud/storage` and
 * lists / describes Cloud Storage (GCS) buckets in the active project.
 *
 * The SDK is an OPTIONAL dependency — never a static import, never a hard dep.
 * Credentials are resolved by Application Default Credentials (ADC); we only
 * check for the presence of a credential/project signal (never its value).
 */

import {
  hasEnv,
  noCreds,
  notInstalled,
  tryImport,
  type CloudAvailability,
  type CloudCallOptions,
  type CloudDescribeParams,
  type CloudListParams,
  type CloudProvider,
  type CloudResource,
} from "./provider.js";

const STORAGE_PKG = "@google-cloud/storage";

function isGcs(resourceType: string): boolean {
  const rt = resourceType.toLowerCase();
  return (
    rt === "gcs" ||
    rt === "gcs:bucket" ||
    rt === "storage" ||
    rt === "bucket" ||
    rt === "buckets"
  );
}

function unsupported(resourceType: string): Error {
  return new Error(
    `gcp: unsupported resourceType "${resourceType}" (supported: gcs / bucket)`,
  );
}

export class GcpCloudProvider implements CloudProvider {
  readonly vendor = "gcp" as const;

  async detect(): Promise<CloudAvailability> {
    const hasCreds = hasEnv(
      "GOOGLE_APPLICATION_CREDENTIALS",
      "GOOGLE_CLOUD_PROJECT",
      "GCLOUD_PROJECT",
      "GCP_PROJECT",
      "GOOGLE_CLOUD_QUOTA_PROJECT",
    );
    if (!hasCreds) {
      return noCreds(
        "gcp",
        "set GOOGLE_APPLICATION_CREDENTIALS + GOOGLE_CLOUD_PROJECT, or configure ADC",
      );
    }
    const mod = await tryImport(STORAGE_PKG);
    if (!mod) return notInstalled(STORAGE_PKG);
    return { available: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async storage(): Promise<any> {
    const mod = await tryImport(STORAGE_PKG);
    if (!mod) throw new Error(notInstalled(STORAGE_PKG).reason);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Storage = (mod as any).Storage;
    const projectId =
      process.env["GOOGLE_CLOUD_PROJECT"] ??
      process.env["GCLOUD_PROJECT"] ??
      process.env["GCP_PROJECT"];
    return new Storage(projectId ? { projectId } : {});
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toResource(b: any): CloudResource {
    const name = String(b?.name ?? b?.id ?? "");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = (b?.metadata ?? {}) as any;
    const resource: CloudResource = {
      id: name,
      name,
      type: "gcs:bucket",
      vendor: "gcp",
      metadata: { storageClass: meta?.storageClass ?? null },
    };
    if (meta?.location) resource.region = String(meta.location);
    if (meta?.timeCreated) resource.createdAt = new Date(meta.timeCreated).toISOString();
    return resource;
  }

  async list(params: CloudListParams, opts: CloudCallOptions): Promise<CloudResource[]> {
    if (!isGcs(params.resourceType)) throw unsupported(params.resourceType);
    const storage = await this.storage();
    const [buckets] = await storage.getBuckets();
    if (opts.signal.aborted) throw new Error("gcp: aborted");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const list: any[] = Array.isArray(buckets) ? buckets : [];
    const filtered = params.region
      ? list.filter((b) => String(b?.metadata?.location) === params.region)
      : list;
    return filtered.slice(0, params.maxItems).map((b) => this.toResource(b));
  }

  async describe(
    params: CloudDescribeParams,
    opts: CloudCallOptions,
  ): Promise<CloudResource | null> {
    if (!isGcs(params.resourceType)) throw unsupported(params.resourceType);
    const storage = await this.storage();
    const bucket = storage.bucket(params.id);
    const [exists] = await bucket.exists();
    if (opts.signal.aborted) throw new Error("gcp: aborted");
    if (!exists) return null;
    const [metadata] = await bucket.getMetadata();
    return this.toResource({ name: params.id, metadata });
  }
}
