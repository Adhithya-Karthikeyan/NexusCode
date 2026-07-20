import { describe, it, expect, afterEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createNexusMcpServer,
  serveTransport,
  McpClient,
  bridgeClientTools,
} from "../src/index.js";
import { PermissionGate, runTool, type Tool, type ToolContext } from "@nexuscode/tools";

/** A trivial in-memory tool exposed via the NexusCode MCP server. */
const upperTool: Tool = {
  name: "upper",
  description: "Uppercase the input text.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  permission: "read",
  async run(input): Promise<{ ok: boolean; content: { type: "text"; text: string }[] }> {
    const text = String((input as { text?: unknown })?.text ?? "");
    return { ok: true, content: [{ type: "text", text: text.toUpperCase() }] };
  },
};

const failTool: Tool = {
  name: "fail",
  description: "Always errors.",
  parameters: { type: "object" },
  permission: "read",
  run: async () => ({ ok: false, isError: true, content: [{ type: "text", text: "nope" }] }),
};

/** A side-effecting tool in the `exec` class — must be gated by default. */
let execRan = false;
const dangerTool: Tool = {
  name: "danger",
  description: "Runs a shell command (exec class).",
  parameters: { type: "object", properties: { cmd: { type: "string" } } },
  permission: "exec",
  run: async () => {
    execRan = true;
    return { ok: true, content: [{ type: "text", text: "ran" }] };
  },
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
  execRan = false;
});

async function connectClientToNexusServer(
  tools: Tool[],
  gate?: PermissionGate,
): Promise<McpClient> {
  const server = createNexusMcpServer(tools, {
    name: "nexuscode",
    cwd: process.cwd(),
    ...(gate ? { gate } : {}),
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await serveTransport(server, st);
  const client = McpClient.withTransport("nexus");
  await client.connectTransport(ct);
  cleanup = async () => {
    await client.close();
    await server.close();
  };
  return client;
}

describe("createNexusMcpServer (expose NexusCode tools as MCP)", () => {
  it("advertises tools with their JSON-Schema parameters", async () => {
    const client = await connectClientToNexusServer([upperTool, failTool]);
    const tools = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["fail", "upper"]);
    const upper = tools.find((t) => t.name === "upper")!;
    expect(upper.inputSchema["type"]).toBe("object");
    expect((upper.inputSchema["properties"] as Record<string, unknown>)["text"]).toBeTruthy();
  });

  it("runs a tool call and maps its ContentBlocks back to MCP content", async () => {
    const client = await connectClientToNexusServer([upperTool]);
    const res = await client.callTool("upper", { text: "hello" });
    expect(res.isError).not.toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text", text: "HELLO" });
  });

  it("reports an unknown tool as an error", async () => {
    const client = await connectClientToNexusServer([upperTool]);
    const res = await client.callTool("ghost", {});
    expect(res.isError).toBe(true);
  });

  it("propagates a tool error through as isError", async () => {
    const client = await connectClientToNexusServer([failTool]);
    const res = await client.callTool("fail", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text", text: "nope" });
  });

  it("denies an ungated exec tool by default (read-only PermissionGate)", async () => {
    const client = await connectClientToNexusServer([dangerTool]);
    const res = await client.callTool("danger", { cmd: "rm -rf /" });
    expect(res.isError).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text" });
    expect(String((res.content[0] as { text: string }).text)).toContain("permission denied");
    // Critically, the tool body never executed.
    expect(execRan).toBe(false);
  });

  it("still allows read-class tools under the default gate", async () => {
    const client = await connectClientToNexusServer([upperTool]);
    const res = await client.callTool("upper", { text: "ok" });
    expect(res.isError).not.toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text", text: "OK" });
  });

  it("runs an exec tool when an explicit gate approves it", async () => {
    const gate = new PermissionGate({ mode: "full-access" });
    const client = await connectClientToNexusServer([dangerTool], gate);
    const res = await client.callTool("danger", { cmd: "echo hi" });
    expect(res.isError).not.toBe(true);
    expect(execRan).toBe(true);
    expect(res.content[0]).toMatchObject({ type: "text", text: "ran" });
  });

  it("honors a denylist on an explicit gate", async () => {
    const gate = new PermissionGate({ mode: "full-access", denylist: ["danger"] });
    const client = await connectClientToNexusServer([dangerTool], gate);
    const res = await client.callTool("danger", { cmd: "echo hi" });
    expect(res.isError).toBe(true);
    expect(execRan).toBe(false);
  });

  it("round-trips: NexusCode server tool → MCP → bridged back to a Tool", async () => {
    const client = await connectClientToNexusServer([upperTool]);
    const bridged = await bridgeClientTools(client, { namespace: false });
    const upper = bridged.find((t) => t.name === "upper")!;
    const ctx: ToolContext = { signal: new AbortController().signal, cwd: process.cwd() };
    const result = await runTool(upper, { text: "abc" }, ctx);
    expect(result.content[0]).toMatchObject({ type: "text", text: "ABC" });
  });
});
