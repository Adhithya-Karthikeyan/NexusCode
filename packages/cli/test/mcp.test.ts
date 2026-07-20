import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { McpClient, McpClientManager } from "@nexuscode/mcp";
import { ToolRegistry, runTool, type ToolContext } from "@nexuscode/tools";
import { registerMcpTools } from "../src/mcp.js";

/**
 * Build a deterministic in-process MCP server (two tools) wired to a connected
 * `McpClient` over an in-memory transport — NO subprocess, NO network — so the
 * discovery → bridge → `ToolRegistry` wiring the engine relies on is exercised
 * fully offline.
 */
async function startInProcessServer(
  name: string,
  opts?: { trustAnnotations?: boolean },
): Promise<{ manager: McpClientManager; close: () => Promise<void> }> {
  const server = new McpServer({ name: "test-mcp", version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo a message.", inputSchema: { message: z.string() }, annotations: { readOnlyHint: true } },
    async ({ message }) => ({ content: [{ type: "text", text: message }] }),
  );
  server.registerTool(
    "add",
    { description: "Add two numbers.", inputSchema: { a: z.number(), b: z.number() } },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = McpClient.withTransport(name, opts);
  await client.connectTransport(clientTransport);

  const manager = new McpClientManager();
  manager.addClient(client);

  return {
    manager,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const ctx = (): ToolContext => ({ signal: new AbortController().signal, cwd: process.cwd() });

describe("mcp wiring — discover + register into the ToolRegistry", () => {
  it("discovers every tool from a connected in-process server", async () => {
    const { manager, close } = await startInProcessServer("acme");
    try {
      const tools = await manager.discoverTools();
      const names = tools.map((t) => `${t.server}/${t.descriptor.name}`).sort();
      expect(names).toEqual(["acme/add", "acme/echo"]);
    } finally {
      await close();
    }
  });

  it("registers discovered tools as namespaced Tools the agent loop can call", async () => {
    const { manager, close } = await startInProcessServer("acme");
    try {
      const tools = await manager.discoverTools();
      const registry = new ToolRegistry();
      const count = registerMcpTools(registry, tools);
      expect(count).toBe(2);

      // Namespaced so two servers can't collide.
      expect(registry.has("acme__echo")).toBe(true);
      expect(registry.has("acme__add")).toBe(true);

      // The bridged tool actually calls the live MCP server and returns content.
      const echo = registry.get("acme__echo");
      const res = await runTool(echo, { message: "ping" }, ctx());
      expect(res.content.some((b) => b.type === "text" && b.text === "ping")).toBe(true);

      const add = registry.get("acme__add");
      const sum = await runTool(add, { a: 2, b: 3 }, ctx());
      expect(sum.content.some((b) => b.type === "text" && b.text === "5")).toBe(true);
    } finally {
      await close();
    }
  });

  it("an untrusted server's readOnlyHint tool is NOT auto-downgraded to read (floors at network)", async () => {
    const { manager, close } = await startInProcessServer("acme"); // no trustAnnotations → untrusted
    try {
      const tools = await manager.discoverTools();
      const registry = new ToolRegistry();
      registerMcpTools(registry, tools);
      expect(registry.get("acme__echo").permission).toBe("network"); // untrusted readOnlyHint
      expect(registry.get("acme__add").permission).toBe("network"); // conservative default
    } finally {
      await close();
    }
  });

  it("read-only MCP tools are classified 'read' only when the server is explicitly trusted", async () => {
    const { manager, close } = await startInProcessServer("acme", { trustAnnotations: true });
    try {
      const tools = await manager.discoverTools();
      const registry = new ToolRegistry();
      registerMcpTools(registry, tools);
      expect(registry.get("acme__echo").permission).toBe("read"); // readOnlyHint + trusted
      expect(registry.get("acme__add").permission).toBe("network"); // conservative default
    } finally {
      await close();
    }
  });

  it("does not overwrite an existing (built-in) tool name", async () => {
    const { manager, close } = await startInProcessServer("acme");
    try {
      const tools = await manager.discoverTools();
      const registry = new ToolRegistry();
      // Pre-register a tool that collides with the bridged name.
      registry.register({
        name: "acme__echo",
        description: "builtin",
        parameters: { type: "object" },
        permission: "read",
        run: async () => ({ ok: true, content: [{ type: "text", text: "builtin" }] }),
      });
      const count = registerMcpTools(registry, tools);
      // echo collides (skipped), add is new.
      expect(count).toBe(1);
      const res = await runTool(registry.get("acme__echo"), {}, ctx());
      expect(res.content.some((b) => b.type === "text" && b.text === "builtin")).toBe(true);
    } finally {
      await close();
    }
  });
});
