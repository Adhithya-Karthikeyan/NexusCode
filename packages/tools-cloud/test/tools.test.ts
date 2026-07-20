/**
 * Offline tests for @nexuscode/tools-cloud. NO real cloud calls: every provider
 * is a FakeCloudProvider whose SDK/cred detection and results are scripted. The
 * default (real) providers are also exercised — offline they must report
 * "unavailable" (no creds / SDK absent) and produce a non-crashing isError
 * ToolResult, proving the optional-lazy path degrades gracefully.
 */

import { describe, expect, it } from "vitest";
import { NexusError } from "@nexuscode/shared";
import type { Tool, ToolContext, ToolResult } from "@nexuscode/tools";
import {
  createCloudTools,
  HARD_MAX_ITEMS,
  type CloudAvailability,
  type CloudCallOptions,
  type CloudDescribeParams,
  type CloudListParams,
  type CloudProvider,
  type CloudResource,
  type CloudVendor,
} from "../src/index.js";

function ctx(signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, cwd: "/tmp" };
}

function textOf(result: ToolResult): string {
  return result.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

async function run(tool: Tool, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
  const out = tool.run(input, ctx(signal));
  // These tools return Promise<ToolResult> (batch).
  return out as Promise<ToolResult>;
}

interface FakeOpts {
  availability?: CloudAvailability;
  resources?: CloudResource[];
  describeResult?: CloudResource | null;
  onList?: (params: CloudListParams, opts: CloudCallOptions) => void;
  listImpl?: (params: CloudListParams, opts: CloudCallOptions) => Promise<CloudResource[]>;
}

class FakeCloudProvider implements CloudProvider {
  readonly vendor: CloudVendor;
  lastList?: CloudListParams;
  lastDescribe?: CloudDescribeParams;
  constructor(
    vendor: CloudVendor,
    private readonly opts: FakeOpts = {},
  ) {
    this.vendor = vendor;
  }
  async detect(): Promise<CloudAvailability> {
    return this.opts.availability ?? { available: true };
  }
  async list(params: CloudListParams, o: CloudCallOptions): Promise<CloudResource[]> {
    this.lastList = params;
    this.opts.onList?.(params, o);
    if (this.opts.listImpl) return this.opts.listImpl(params, o);
    return this.opts.resources ?? [];
  }
  async describe(params: CloudDescribeParams): Promise<CloudResource | null> {
    this.lastDescribe = params;
    return this.opts.describeResult ?? null;
  }
}

function bucket(name: string): CloudResource {
  return { id: name, name, type: "s3:bucket", vendor: "aws", region: "us-east-1" };
}

function findTool(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

describe("createCloudTools — contract", () => {
  it("returns cloud_list and cloud_describe with the network permission and a timeout", () => {
    const tools = createCloudTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["cloud_describe", "cloud_list"]);
    for (const t of tools) {
      expect(t.permission).toBe("network");
      expect(typeof t.timeoutMs).toBe("number");
      expect((t.parameters as { type: string }).type).toBe("object");
    }
  });
});

describe("cloud_list — via mocked provider", () => {
  it("returns fake resources as JSON with a count", async () => {
    const aws = new FakeCloudProvider("aws", { resources: [bucket("alpha"), bucket("beta")] });
    const tools = createCloudTools({ providers: { aws } });
    const res = await run(findTool(tools, "cloud_list"), { vendor: "aws", resourceType: "s3" });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as { count: number; vendor: string; resources: CloudResource[] };
    expect(parsed.vendor).toBe("aws");
    expect(parsed.count).toBe(2);
    expect(parsed.resources.map((r) => r.name)).toEqual(["alpha", "beta"]);
  });

  it("passes region and clamps maxItems to the hard cap", async () => {
    const aws = new FakeCloudProvider("aws", { resources: [bucket("a")] });
    const tools = createCloudTools({ providers: { aws } });
    await run(findTool(tools, "cloud_list"), {
      vendor: "aws",
      resourceType: "s3",
      region: "eu-west-1",
      maxItems: 999999,
    });
    expect(aws.lastList?.region).toBe("eu-west-1");
    expect(aws.lastList?.maxItems).toBe(HARD_MAX_ITEMS);
  });

  it("caps the number of returned resources to maxItems", async () => {
    const many = Array.from({ length: 10 }, (_, i) => bucket(`b${i}`));
    const aws = new FakeCloudProvider("aws", { resources: many });
    const tools = createCloudTools({ providers: { aws } });
    const res = await run(findTool(tools, "cloud_list"), {
      vendor: "aws",
      resourceType: "s3",
      maxItems: 3,
    });
    const parsed = JSON.parse(textOf(res)) as { count: number };
    expect(parsed.count).toBe(3);
  });

  it("surfaces a non-crashing isError when the provider is unavailable", async () => {
    const aws = new FakeCloudProvider("aws", {
      availability: { available: false, reason: "@aws-sdk/client-s3 not installed (npm i @aws-sdk/client-s3)" },
    });
    const tools = createCloudTools({ providers: { aws } });
    const res = await run(findTool(tools, "cloud_list"), { vendor: "aws", resourceType: "s3" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("not installed");
  });

  it("returns isError (not a throw) when the provider call fails, and redacts secrets in the message", async () => {
    const aws = new FakeCloudProvider("aws", {
      listImpl: async () => {
        throw new Error("boom leaked key AKIAIOSFODNN7EXAMPLE while calling s3");
      },
    });
    const tools = createCloudTools({ providers: { aws } });
    const res = await run(findTool(tools, "cloud_list"), { vendor: "aws", resourceType: "s3" });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toContain("failed");
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("[REDACTED]");
  });

  it("rejects an unknown vendor with NexusError(invalid_argument)", async () => {
    const tools = createCloudTools();
    await expect(run(findTool(tools, "cloud_list"), { vendor: "digitalocean", resourceType: "x" })).rejects.toBeInstanceOf(NexusError);
  });

  it("rejects a missing resourceType with NexusError(invalid_argument)", async () => {
    const tools = createCloudTools();
    await expect(run(findTool(tools, "cloud_list"), { vendor: "aws" })).rejects.toBeInstanceOf(NexusError);
  });

  it("enforces the timeout budget when the provider ignores its signal", async () => {
    const aws = new FakeCloudProvider("aws", {
      listImpl: () => new Promise<CloudResource[]>(() => {}), // never resolves
    });
    const tools = createCloudTools({ providers: { aws }, timeoutMs: 20 });
    const res = await run(findTool(tools, "cloud_list"), { vendor: "aws", resourceType: "s3" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("timed out");
  });

  it("honors an already-aborted signal as cancellation", async () => {
    const aws = new FakeCloudProvider("aws", {
      listImpl: () => new Promise<CloudResource[]>(() => {}),
    });
    const tools = createCloudTools({ providers: { aws } });
    const controller = new AbortController();
    controller.abort();
    const res = await run(findTool(tools, "cloud_list"), { vendor: "aws", resourceType: "s3" }, controller.signal);
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("cancelled");
  });
});

describe("cloud_describe — via mocked provider", () => {
  it("returns the described resource as JSON", async () => {
    const gcp = new FakeCloudProvider("gcp", {
      describeResult: { id: "my-bucket", name: "my-bucket", type: "gcs:bucket", vendor: "gcp", region: "us" },
    });
    const tools = createCloudTools({ providers: { gcp } });
    const res = await run(findTool(tools, "cloud_describe"), {
      vendor: "gcp",
      resourceType: "gcs",
      id: "my-bucket",
    });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(textOf(res)) as CloudResource;
    expect(parsed.name).toBe("my-bucket");
    expect(gcp.lastDescribe?.id).toBe("my-bucket");
  });

  it("returns isError when the resource is not found", async () => {
    const gcp = new FakeCloudProvider("gcp", { describeResult: null });
    const tools = createCloudTools({ providers: { gcp } });
    const res = await run(findTool(tools, "cloud_describe"), {
      vendor: "gcp",
      resourceType: "gcs",
      id: "ghost",
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("not found");
  });

  it("requires an id (NexusError on omission)", async () => {
    const tools = createCloudTools();
    await expect(run(findTool(tools, "cloud_describe"), { vendor: "gcp", resourceType: "gcs" })).rejects.toBeInstanceOf(NexusError);
  });
});

describe("default (real) providers — offline graceful degradation", () => {
  const clearEnv = (): Record<string, string | undefined> => {
    const keys = [
      "AWS_ACCESS_KEY_ID", "AWS_PROFILE", "AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE",
      "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI",
      "AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_CLIENT_SECRET", "AZURE_SUBSCRIPTION_ID",
      "AZURE_CLIENT_CERTIFICATE_PATH", "MSI_ENDPOINT", "IDENTITY_ENDPOINT",
      "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "GCP_PROJECT",
      "GOOGLE_CLOUD_QUOTA_PROJECT",
    ];
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    return saved;
  };

  const restoreEnv = (saved: Record<string, string | undefined>): void => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  it("cloud_list on each vendor returns isError without any network call", async () => {
    const saved = clearEnv();
    try {
      const tools = createCloudTools();
      for (const vendor of ["aws", "azure", "gcp"] as const) {
        const res = await run(findTool(tools, "cloud_list"), { vendor, resourceType: "any" });
        expect(res.isError).toBe(true);
        expect(textOf(res)).toContain("unavailable");
      }
    } finally {
      restoreEnv(saved);
    }
  });
});
