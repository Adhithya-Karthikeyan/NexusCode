/**
 * Azure cloud provider (read-oriented). Lazily loads `@azure/arm-storage` for
 * the management surface and `@azure/identity` for credentials, and lists /
 * describes Storage accounts within a subscription.
 *
 * Both packages are OPTIONAL dependencies — never static imports, never hard
 * deps. Credentials are resolved by `DefaultAzureCredential` (env / managed
 * identity / CLI); we only check for the presence of a credential signal plus
 * the required `AZURE_SUBSCRIPTION_ID` (never their values).
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

const ARM_PKG = "@azure/arm-storage";
const IDENTITY_PKG = "@azure/identity";

function isStorage(resourceType: string): boolean {
  const rt = resourceType.toLowerCase();
  return (
    rt === "storage" ||
    rt === "storage:account" ||
    rt === "storageaccount" ||
    rt === "storageaccounts" ||
    rt === "account"
  );
}

function unsupported(resourceType: string): Error {
  return new Error(
    `azure: unsupported resourceType "${resourceType}" (supported: storage / account)`,
  );
}

function subscriptionId(): string {
  const id = process.env["AZURE_SUBSCRIPTION_ID"];
  if (!id) throw new Error("azure: AZURE_SUBSCRIPTION_ID is required");
  return id;
}

export class AzureCloudProvider implements CloudProvider {
  readonly vendor = "azure" as const;

  async detect(): Promise<CloudAvailability> {
    const hasCreds = hasEnv(
      "AZURE_CLIENT_ID",
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_CLIENT_CERTIFICATE_PATH",
      "MSI_ENDPOINT",
      "IDENTITY_ENDPOINT",
    );
    if (!hasCreds) {
      return noCreds(
        "azure",
        "set AZURE_TENANT_ID/AZURE_CLIENT_ID (+ secret), or use a managed identity",
      );
    }
    if (!hasEnv("AZURE_SUBSCRIPTION_ID")) {
      return noCreds("azure", "set AZURE_SUBSCRIPTION_ID");
    }
    const arm = await tryImport(ARM_PKG);
    if (!arm) return notInstalled(ARM_PKG);
    const identity = await tryImport(IDENTITY_PKG);
    if (!identity) return notInstalled(IDENTITY_PKG);
    return { available: true };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async client(): Promise<any> {
    const arm = await tryImport(ARM_PKG);
    if (!arm) throw new Error(notInstalled(ARM_PKG).reason);
    const identity = await tryImport(IDENTITY_PKG);
    if (!identity) throw new Error(notInstalled(IDENTITY_PKG).reason);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const StorageManagementClient = (arm as any).StorageManagementClient;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const DefaultAzureCredential = (identity as any).DefaultAzureCredential;
    return new StorageManagementClient(new DefaultAzureCredential(), subscriptionId());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private toResource(a: any): CloudResource {
    const name = String(a?.name ?? "");
    const resource: CloudResource = {
      id: String(a?.id ?? name),
      name,
      type: "storage:account",
      vendor: "azure",
      metadata: { kind: a?.kind ?? null, sku: a?.sku?.name ?? null },
    };
    if (a?.location) resource.region = String(a.location);
    if (a?.creationTime) resource.createdAt = new Date(a.creationTime).toISOString();
    return resource;
  }

  async list(params: CloudListParams, opts: CloudCallOptions): Promise<CloudResource[]> {
    if (!isStorage(params.resourceType)) throw unsupported(params.resourceType);
    const client = await this.client();
    const out: CloudResource[] = [];
    // The management client returns an async pageable iterator.
    for await (const account of client.storageAccounts.list()) {
      if (opts.signal.aborted) throw new Error("azure: aborted");
      if (params.region && String(account?.location) !== params.region) continue;
      out.push(this.toResource(account));
      if (out.length >= params.maxItems) break;
    }
    return out;
  }

  async describe(
    params: CloudDescribeParams,
    opts: CloudCallOptions,
  ): Promise<CloudResource | null> {
    if (!isStorage(params.resourceType)) throw unsupported(params.resourceType);
    const client = await this.client();
    // Without a resource group we locate the account by name across the sub.
    for await (const account of client.storageAccounts.list()) {
      if (opts.signal.aborted) throw new Error("azure: aborted");
      if (String(account?.name) === params.id) return this.toResource(account);
    }
    return null;
  }
}
