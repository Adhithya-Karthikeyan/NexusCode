/**
 * The (basic) NexusCode MCP server (system-spec §7). It exposes a set of
 * `@nexuscode/tools` `Tool`s as MCP tools so any MCP client — Claude Desktop,
 * another NexusCode instance, an IDE — can list and call NexusCode's built-in
 * capabilities. Tools are advertised with their JSON-Schema `parameters`; a
 * `tools/call` runs the tool through `runTool` (honoring streaming + timeout)
 * and maps its `ContentBlock`s back to MCP content.
 *
 * Transport is decoupled: `createNexusMcpServer` returns a bare SDK `Server`;
 * `serveStdio` wires it to stdin/stdout for the real CLI, while tests connect it
 * to an in-memory transport. No network is required to exercise it.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ContentBlock } from "@nexuscode/shared";
import { PermissionGate, runTool, type Tool, type ToolContext } from "@nexuscode/tools";

export interface NexusMcpServerOptions {
  /** Advertised server name (default "nexuscode"). */
  name?: string;
  /** Advertised server version (default "0.0.0"). */
  version?: string;
  /** Workspace root handed to every tool call as `ToolContext.cwd`. */
  cwd?: string;
  /**
   * PermissionGate consulted before EVERY `tools/call`. A connecting MCP client
   * (Claude Desktop, an IDE, another process over stdio/network) is untrusted:
   * without a gate it could invoke any exposed tool — including `write`/`exec`
   * classes — with arbitrary arguments and no approval. When omitted, the server
   * defaults to a **read-only** gate so exposing it never silently grants
   * ungated writes or command execution. Pass an explicit gate (e.g.
   * `workspace-write` with an `approve` callback) to widen this deliberately;
   * exposing `exec`/`write` tools without a gate that can approve them is unsafe.
   */
  gate?: PermissionGate;
}

/** MCP content block shape produced by a `tools/call` result. */
interface McpOutContent {
  type: string;
  [k: string]: unknown;
}

/** Map a normalized `ContentBlock` to an MCP output content block. */
function contentBlockToMcp(block: ContentBlock): McpOutContent {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image": {
      const data = typeof block.data === "string" ? block.data : "";
      return { type: "image", data, mimeType: block.mime };
    }
    case "thinking":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "text", text: JSON.stringify(block.input ?? {}) };
    case "tool_result": {
      const inner = block.content.map(contentBlockToMcp);
      const text = inner
        .map((c) => (c.type === "text" ? String(c["text"]) : `[${c.type}]`))
        .join("");
      return { type: "text", text };
    }
    default:
      return { type: "text", text: "" };
  }
}

/**
 * Build an MCP `Server` that exposes `tools` as MCP tools. The returned server
 * is not yet connected — hand it a transport via `server.connect(transport)` or
 * the `serveStdio` helper.
 */
export function createNexusMcpServer(
  tools: Iterable<Tool>,
  opts: NexusMcpServerOptions = {},
): Server {
  const byName = new Map<string, Tool>();
  for (const t of tools) byName.set(t.name, t);
  const cwd = opts.cwd ?? process.cwd();
  // Untrusted MCP clients never get ungated tool execution: default to
  // read-only when the integrator does not supply an explicit gate.
  const gate = opts.gate ?? new PermissionGate({ mode: "read-only" });

  const server = new Server(
    { name: opts.name ?? "nexuscode", version: opts.version ?? "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...byName.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: normalizeInputSchema(t.parameters),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args } = request.params;
    const tool = byName.get(name);
    if (!tool) {
      return {
        content: [{ type: "text", text: `no such tool: ${name}` }],
        isError: true,
      };
    }

    // Every tools/call passes through the PermissionGate before any tool runs.
    // A denial short-circuits with an error result — the tool is never invoked.
    const decision = await gate.check(tool, args ?? {});
    if (!decision.allowed) {
      return {
        content: [{ type: "text", text: `permission denied: ${decision.reason}` }],
        isError: true,
      };
    }

    const ctx: ToolContext = { signal: extra.signal, cwd };
    try {
      const result = await runTool(tool, args ?? {}, ctx);
      return {
        content: result.content.map(contentBlockToMcp),
        isError: result.isError === true,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  });

  return server;
}

/** MCP requires `inputSchema` to be a JSON-Schema object; coerce/guard shape. */
function normalizeInputSchema(parameters: Record<string, unknown>): {
  type: "object";
  [k: string]: unknown;
} {
  if (parameters && parameters["type"] === "object") {
    return parameters as { type: "object"; [k: string]: unknown };
  }
  return { type: "object", properties: {}, ...parameters };
}

/** Connect a server to stdio (the real CLI entrypoint). */
export async function serveStdio(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/** Connect a server to any caller-supplied transport (in-process / stdio). */
export async function serveTransport(server: Server, transport: Transport): Promise<void> {
  await server.connect(transport);
}
