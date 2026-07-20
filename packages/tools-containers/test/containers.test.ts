/**
 * Offline tests for @nexuscode/tools-containers. Every tool is pointed at a
 * deterministic fake `docker` / `kubectl` fixture via injectable bin paths — no
 * real docker, kubectl, oc, daemon, cluster, or network is ever touched.
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Tool, ToolContext, ToolResult } from "@nexuscode/tools";
import { isNexusError } from "@nexuscode/shared";
import { createContainerTools, parseNdjson } from "../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_DOCKER = path.join(HERE, "fixtures", "fake-docker.mjs");
const FAKE_KUBECTL = path.join(HERE, "fixtures", "fake-kubectl.mjs");

function tools(overrides: Record<string, unknown> = {}): Map<string, Tool> {
  const list = createContainerTools({
    dockerBin: FAKE_DOCKER,
    kubectlBin: FAKE_KUBECTL,
    ocBin: FAKE_KUBECTL,
    ...overrides,
  });
  return new Map(list.map((t) => [t.name, t]));
}

function ctx(signal?: AbortSignal): ToolContext {
  return { signal: signal ?? new AbortController().signal, cwd: process.cwd() };
}

async function run(tool: Tool, input: unknown, c: ToolContext = ctx()): Promise<ToolResult> {
  const out = tool.run(input, c);
  // Every container tool is a batch tool (returns Promise<ToolResult>).
  return out as Promise<ToolResult>;
}

function text(r: ToolResult): string {
  return r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

describe("factory", () => {
  it("returns the five container tools with correct names and permissions", () => {
    const t = tools();
    expect([...t.keys()].sort()).toEqual(
      ["docker_images", "docker_logs", "docker_ps", "k8s_get", "k8s_logs"].sort(),
    );
    expect(t.get("docker_ps")!.permission).toBe("exec");
    expect(t.get("docker_images")!.permission).toBe("exec");
    expect(t.get("docker_logs")!.permission).toBe("exec");
    expect(t.get("k8s_get")!.permission).toBe("network");
    expect(t.get("k8s_logs")!.permission).toBe("network");
    for (const tool of t.values()) {
      expect(tool.parameters).toMatchObject({ type: "object" });
      expect(typeof tool.timeoutMs).toBe("number");
    }
  });
});

describe("parseNdjson", () => {
  it("parses one object per line and skips blanks", () => {
    const { rows, parseError } = parseNdjson('{"a":1}\n\n{"b":2}\n');
    expect(parseError).toBeUndefined();
    expect(rows).toEqual([{ a: 1 }, { b: 2 }]);
  });
  it("reports a parse error on a malformed line", () => {
    const { parseError } = parseNdjson("{not json}");
    expect(parseError).toContain("could not parse");
  });
});

describe("docker_ps", () => {
  it("lists running containers by default", async () => {
    const r = await run(tools().get("docker_ps")!, {});
    expect(r.isError).toBeFalsy();
    const rows = JSON.parse(text(r));
    expect(rows).toHaveLength(1);
    expect(rows[0].Names).toBe("web");
  });

  it("includes stopped containers when all=true", async () => {
    const r = await run(tools().get("docker_ps")!, { all: true });
    const rows = JSON.parse(text(r));
    expect(rows).toHaveLength(2);
    expect(rows.map((x: { Names: string }) => x.Names)).toContain("db");
  });

  it("passes a filter through to the CLI", async () => {
    const r = await run(tools().get("docker_ps")!, { all: true, filter: "name=web" });
    const rows = JSON.parse(text(r));
    expect(rows).toHaveLength(1);
  });
});

describe("docker_images", () => {
  it("lists images as parsed JSON", async () => {
    const r = await run(tools().get("docker_images")!, {});
    const rows = JSON.parse(text(r));
    expect(rows.map((x: { Repository: string }) => x.Repository)).toEqual(["nginx", "postgres"]);
  });
});

describe("docker_logs", () => {
  it("returns log lines", async () => {
    const r = await run(tools().get("docker_logs")!, { container: "web" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain("log line 1");
    expect(text(r)).toContain("log line 3");
  });

  it("honors tail", async () => {
    const r = await run(tools().get("docker_logs")!, { container: "web", tail: 1 });
    expect(text(r)).toContain("log line 3");
    expect(text(r)).not.toContain("log line 1");
  });

  it("errors on a missing container (non-zero exit)", async () => {
    const r = await run(tools().get("docker_logs")!, { container: "missing" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("No such container");
  });

  it("rejects a container name that starts with a dash (arg-injection guard)", async () => {
    await expect(run(tools().get("docker_logs")!, { container: "--rm" })).rejects.toSatisfy(isNexusError);
  });

  it("rejects a negative tail", async () => {
    const r = await run(tools().get("docker_logs")!, { container: "web", tail: -5 });
    expect(r.isError).toBe(true);
  });
});

describe("not installed / feature detection", () => {
  it("returns a clean not-installed error instead of crashing", async () => {
    const t = tools({ dockerBin: "/definitely/not/a/real/docker/binary" });
    const r = await run(t.get("docker_ps")!, {});
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not installed");
  });
});

describe("timeout", () => {
  it("kills a hanging CLI and flags a timeout", async () => {
    const t = tools({ timeoutMs: 200 });
    const r = await run(t.get("docker_logs")!, { container: "hang" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("timed out");
  }, 10_000);
});

describe("cancellation", () => {
  it("aborts a hanging CLI when the signal fires", async () => {
    const ac = new AbortController();
    const t = tools({ timeoutMs: 5_000 });
    const p = run(t.get("docker_logs")!, { container: "hang" }, ctx(ac.signal));
    setTimeout(() => ac.abort(), 100);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("cancelled");
  }, 10_000);
});

describe("k8s_get", () => {
  it("gets pods as parsed JSON", async () => {
    const r = await run(tools().get("k8s_get")!, { resource: "pods" });
    expect(r.isError).toBeFalsy();
    const doc = JSON.parse(text(r));
    expect(doc.items[0].metadata.name).toBe("pods-1");
    expect(doc.items[0].metadata.namespace).toBe("default");
  });

  it("maps aliases and passes the namespace", async () => {
    const r = await run(tools().get("k8s_get")!, { resource: "svc", namespace: "prod" });
    const doc = JSON.parse(text(r));
    expect(doc.items[0].kind).toBe("Service");
    expect(doc.items[0].metadata.namespace).toBe("prod");
  });

  it("supports --all-namespaces", async () => {
    const r = await run(tools().get("k8s_get")!, { resource: "deployments", allNamespaces: true });
    const doc = JSON.parse(text(r));
    expect(doc.items[0].metadata.namespace).toBe("*");
    expect(doc.items[0].kind).toBe("Deployment");
  });

  it("rejects a resource outside the read-safe allowlist", async () => {
    const r = await run(tools().get("k8s_get")!, { resource: "secrets" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("must be one of");
  });

  it("drives the oc binary when cli=oc", async () => {
    // ocBin points at the same fake; a bad ocBin proves the selector is used.
    const t = tools({ ocBin: "/no/such/oc" });
    const r = await run(t.get("k8s_get")!, { resource: "pods", cli: "oc" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not installed");
  });
});

describe("k8s_logs", () => {
  it("returns pod logs and plumbs flags", async () => {
    const r = await run(tools().get("k8s_logs")!, {
      pod: "web-1",
      namespace: "prod",
      container: "app",
      tail: 20,
      previous: true,
    });
    expect(r.isError).toBeFalsy();
    const out = text(r);
    expect(out).toContain("pod=web-1");
    expect(out).toContain("ns=prod");
    expect(out).toContain("container=app");
    expect(out).toContain("tail=20");
    expect(out).toContain("previous");
  });

  it("errors on a missing pod", async () => {
    const r = await run(tools().get("k8s_logs")!, { pod: "missing" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("not found");
  });

  it("rejects a pod name starting with a dash", async () => {
    await expect(run(tools().get("k8s_logs")!, { pod: "-x" })).rejects.toSatisfy(isNexusError);
  });
});
