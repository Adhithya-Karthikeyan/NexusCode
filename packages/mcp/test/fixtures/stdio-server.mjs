#!/usr/bin/env node
/**
 * A trivial REAL MCP server over stdio, spawned as an actual OS subprocess by
 * `client.test.ts`'s child-process reaper tests. Unlike the rest of this test
 * suite (in-process `InMemoryTransport`, see harness.ts), the reaper's whole
 * job is cleaning up a real spawned process — so that specific scenario needs
 * a real one to spawn, not a fake.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "reaper-test-fixture", version: "1.0.0" });
server.registerTool(
  "ping",
  { description: "Replies pong.", inputSchema: { note: z.string().optional() } },
  async () => ({ content: [{ type: "text", text: "pong" }] }),
);
await server.connect(new StdioServerTransport());
