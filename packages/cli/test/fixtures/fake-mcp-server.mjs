#!/usr/bin/env node
/**
 * Deterministic in-process (stdio) MCP server for offline CLI tests. It speaks
 * real MCP over its stdio pipes using the official SDK and exposes two trivial
 * tools. NO network — the `nexus mcp` command spawns this and discovers its
 * tools exactly as it would a real server.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "fake-mcp", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    description: "Echo back the given message.",
    inputSchema: { message: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ message }) => ({ content: [{ type: "text", text: message }] }),
);

server.registerTool(
  "add",
  {
    description: "Add two numbers.",
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
