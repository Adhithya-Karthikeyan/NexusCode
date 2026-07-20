/**
 * AWS cloud provider (read-oriented). Lazily loads `@aws-sdk/client-s3` and
 * feature-detects the standard AWS credential signals. Supports listing and
 * describing S3 buckets — the canonical, universally-available read surface.
 *
 * The SDK is an OPTIONAL dependency: never imported statically, never a hard
 * dep. Credentials are resolved by the SDK's own default provider chain; we
 * only check for the *presence* of a credential signal (never its value).
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

const S3_PKG = "@aws-sdk/client-s3";

/** Resource-type aliases that map to "S3 bucket". */
function isS3(resourceType: string): boolean {
  const rt = resourceType.toLowerCase();
  return rt === "s3" || rt === "s3:bucket" || rt === "bucket" || rt === "buckets";
}

function unsupported(resourceType: string): Error {
  return new Error(
    `aws: unsupported resourceType "${resourceType}" (supported: s3 / bucket)`,
  );
}

export class AwsCloudProvider implements CloudProvider {
  readonly vendor = "aws" as const;

  async detect(): Promise<CloudAvailability> {
    const hasCreds = hasEnv(
      "AWS_ACCESS_KEY_ID",
      "AWS_PROFILE",
      "AWS_ROLE_ARN",
      "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
      "AWS_CONTAINER_CREDENTIALS_FULL_URI",
    );
    if (!hasCreds) {
      return noCreds("aws", "set AWS_ACCESS_KEY_ID / AWS_PROFILE, or run under an IAM role");
    }
    const mod = await tryImport(S3_PKG);
    if (!mod) return notInstalled(S3_PKG);
    return { available: true };
  }

  private async s3Client(region: string | undefined): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    client: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mod: any;
  }> {
    const mod = await tryImport(S3_PKG);
    if (!mod) throw new Error(notInstalled(S3_PKG).reason);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const S3Client = (mod as any).S3Client;
    const client = new S3Client(region ? { region } : {});
    return { client, mod };
  }

  async list(params: CloudListParams, opts: CloudCallOptions): Promise<CloudResource[]> {
    if (!isS3(params.resourceType)) throw unsupported(params.resourceType);
    const { client, mod } = await this.s3Client(params.region);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ListBucketsCommand = (mod as any).ListBucketsCommand;
      const res = await client.send(new ListBucketsCommand({}), { abortSignal: opts.signal });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buckets: any[] = Array.isArray(res?.Buckets) ? res.Buckets : [];
      return buckets.slice(0, params.maxItems).map((b) => {
        const name = String(b?.Name ?? "");
        const resource: CloudResource = {
          id: name,
          name,
          type: "s3:bucket",
          vendor: "aws",
        };
        if (params.region) resource.region = params.region;
        if (b?.CreationDate) resource.createdAt = new Date(b.CreationDate).toISOString();
        return resource;
      });
    } finally {
      client.destroy?.();
    }
  }

  async describe(
    params: CloudDescribeParams,
    opts: CloudCallOptions,
  ): Promise<CloudResource | null> {
    if (!isS3(params.resourceType)) throw unsupported(params.resourceType);
    const { client, mod } = await this.s3Client(params.region);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const GetBucketLocationCommand = (mod as any).GetBucketLocationCommand;
      const res = await client.send(new GetBucketLocationCommand({ Bucket: params.id }), {
        abortSignal: opts.signal,
      });
      // AWS returns "" for us-east-1.
      const region: string = res?.LocationConstraint || params.region || "us-east-1";
      return {
        id: params.id,
        name: params.id,
        type: "s3:bucket",
        vendor: "aws",
        region,
        metadata: { locationConstraint: res?.LocationConstraint ?? null },
      };
    } finally {
      client.destroy?.();
    }
  }
}
