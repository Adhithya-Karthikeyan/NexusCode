/**
 * A deterministic, in-process MCP test server built with the official SDK's
 * high-level `McpServer`, exposing two trivial tools, one resource, and one
 * prompt. Client and server are wired over an `InMemoryTransport` linked pair —
 * NO subprocess, NO network — so the whole MCP surface is exercised offline.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { McpClient } from "../src/index.js";

export interface Harness {
  server: McpServer;
  client: McpClient;
  close: () => Promise<void>;
}

/** Build the in-process MCP server (not yet connected). */
export function buildTestMcpServer(): McpServer {
  const server = new McpServer({ name: "test-mcp", version: "1.0.0" });

  // Tool 1: echo — read-only (annotation drives permission classification).
  server.registerTool(
    "echo",
    {
      description: "Echo back the given message.",
      inputSchema: { message: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => ({ content: [{ type: "text", text: message }] }),
  );

  // Tool 2: add — no read-only hint (classified as network/approval-worthy).
  server.registerTool(
    "add",
    {
      description: "Add two numbers.",
      inputSchema: { a: z.number(), b: z.number() },
    },
    async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }),
  );

  // Tool 3: boom — always errors, to exercise isError propagation.
  server.registerTool(
    "boom",
    { description: "Always fails." },
    async () => ({ content: [{ type: "text", text: "kaboom" }], isError: true }),
  );

  // A static resource.
  server.registerResource(
    "greeting",
    "test://greeting",
    { description: "A canned greeting.", mimeType: "text/plain" },
    async (uri) => ({
      contents: [{ uri: uri.href, text: "hello from resource", mimeType: "text/plain" }],
    }),
  );

  // A prompt template with one argument.
  server.registerPrompt(
    "greet",
    { description: "Produce a greeting prompt.", argsSchema: { name: z.string() } },
    ({ name }) => ({
      messages: [
        { role: "user", content: { type: "text", text: `Say hello to ${name}.` } },
      ],
    }),
  );

  return server;
}

/** Build the server + a connected `McpClient` over an in-memory transport. */
export async function startHarness(clientName = "test"): Promise<Harness> {
  const server = buildTestMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);

  const client = McpClient.withTransport(clientName);
  await client.connectTransport(clientTransport);

  return {
    server,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
