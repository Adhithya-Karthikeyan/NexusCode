/**
 * @nexuscode/mcp — full Model Context Protocol support (system-spec §7).
 *
 * Three surfaces, all built on the official `@modelcontextprotocol/sdk`:
 *
 *   CLIENT — `McpClient` connects to one server over stdio / SSE / streamable-HTTP
 *            (auth resolved through a `SecretResolver`), and lists + calls TOOLS,
 *            browses + reads RESOURCES, and lists + gets PROMPT templates.
 *            `McpClientManager` fans this across MULTIPLE servers with dynamic
 *            tool discovery.
 *
 *   BRIDGE — `mcpToolToTool` / `bridgeClientTools` wrap discovered MCP tools as
 *            `@nexuscode/tools` `Tool`s (schema → parameters, annotations →
 *            permission, `run` → client call), so the existing native tool loop
 *            invokes MCP tools across ANY provider under the `PermissionGate`.
 *
 *   SERVER — `createNexusMcpServer` exposes NexusCode built-in `Tool`s as an MCP
 *            server (stdio via `serveStdio`) so other MCP clients can drive
 *            NexusCode.
 *
 *   CONFIG — `McpServerConfig` declares a server (transport + command/url + auth).
 */

export {
  McpServerConfig,
  McpAuthConfig,
  McpTransportKind,
  parseMcpServerConfig,
} from "./config.js";
export type {
  McpServerConfigInput,
  McpAuthConfigInput,
} from "./config.js";

export {
  McpClient,
  McpClientManager,
  resolveTransport,
} from "./client.js";
export type {
  SecretResolver,
  McpToolDescriptor,
  McpResourceDescriptor,
  McpPromptDescriptor,
  McpContentBlock,
  McpCallToolResult,
  McpRequestOptions,
  DiscoveredTool,
} from "./client.js";

export {
  mcpToolToTool,
  bridgeClientTools,
  classifyPermission,
  bridgedToolName,
  mapMcpContent,
  mapMcpContentBlocks,
} from "./bridge.js";
export type { BridgeOptions } from "./bridge.js";

export {
  createNexusMcpServer,
  serveStdio,
  serveTransport,
} from "./server.js";
export type { NexusMcpServerOptions } from "./server.js";
