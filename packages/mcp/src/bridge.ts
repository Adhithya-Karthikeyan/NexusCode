/**
 * The MCP → `@nexuscode/tools` bridge (system-spec §7). Every tool a server
 * advertises is wrapped as a first-class `Tool`: its `inputSchema` becomes the
 * tool `parameters`, its annotations drive a coarse `ToolPermission` the
 * `PermissionGate` reasons over, and `run()` forwards to the live `McpClient`.
 * The wrapped tool audits and streams identically to a built-in, so the existing
 * native tool-execution loop can invoke MCP tools across ANY provider without
 * knowing MCP exists.
 */

import type { ContentBlock } from "@nexuscode/shared";
import type { Tool, ToolContext, ToolPermission, ToolResult } from "@nexuscode/tools";
import type { McpClient, McpContentBlock, McpToolDescriptor } from "./client.js";

export interface BridgeOptions {
  /**
   * Prefix each wrapped tool's name with `${server}${separator}`. On by default
   * so two servers exposing `search` do not collide in one `ToolRegistry`.
   */
  namespace?: boolean;
  /** Separator between server name and tool name when `namespace` is on. */
  separator?: string;
  /**
   * Force a permission class for every wrapped tool from this server, overriding
   * annotation-based classification (e.g. pin a trusted server to `"read"`).
   */
  permission?: ToolPermission;
  /**
   * Trust this server's tool annotations (`readOnlyHint`) enough to let them
   * auto-downgrade classification to `"read"`. Overrides the client's own
   * `trustAnnotations` (from its `McpServerConfig`) when provided. MCP
   * annotations are advisory/self-declared by the server — untrusted per the
   * MCP spec — so this defaults to `false` (via the client) unless set here.
   */
  trustAnnotations?: boolean;
}

const DEFAULT_SEPARATOR = "__";

/**
 * Classify an MCP tool into a coarse `ToolPermission`.
 *
 * MCP tool calls cross a transport boundary (a remote server or a spawned
 * subprocess), so the conservative default is `"network"` — which the gate makes
 * ask for approval outside full-access. This never *upgrades* trust: an
 * unannotated tool is treated as external/approval-worthy, not auto-allowed.
 *
 * Annotations are advisory and SELF-DECLARED BY THE SERVER — per the MCP spec
 * they are untrusted hints, not a security boundary. A malicious/compromised
 * remote server could otherwise label a destructive or exfiltrating tool
 * `readOnlyHint: true` and have it auto-run with no approval, since `"read"` is
 * auto-allowed in every `PermissionGate` mode. So:
 *   - `readOnlyHint` only downgrades to `"read"` when `opts.trustAnnotations`
 *     is explicitly `true` (the caller has vetted/configured this server as
 *     trusted). Otherwise an untrusted `readOnlyHint` tool floors at
 *     `"network"` — same as unannotated — so it still requires approval
 *     outside full-access mode.
 *   - `destructiveHint` always floors at `"exec"`, regardless of `readOnlyHint`
 *     or trust: a self-declared-destructive tool must never be treated as
 *     read-only, and `"exec"` is denied outright in read-only mode (unlike
 *     `"network"`, which merely asks).
 */
export function classifyPermission(
  descriptor: McpToolDescriptor,
  opts?: { trustAnnotations?: boolean },
): ToolPermission {
  const a = descriptor.annotations;
  if (a?.destructiveHint === true) return "exec";
  if (opts?.trustAnnotations === true && a?.readOnlyHint === true) return "read";
  return "network";
}

/** Build the bridged tool name for a server/tool pair. */
export function bridgedToolName(
  server: string,
  toolName: string,
  opts?: BridgeOptions,
): string {
  if (opts?.namespace === false) return toolName;
  const sep = opts?.separator ?? DEFAULT_SEPARATOR;
  return `${server}${sep}${toolName}`;
}

/** Map one MCP content block to zero or more normalized `ContentBlock`s. */
export function mapMcpContent(block: McpContentBlock): ContentBlock[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: String(block["text"] ?? "") }];
    case "image":
    case "audio": {
      const mime = String(block["mimeType"] ?? "application/octet-stream");
      const data = block["data"];
      if (block.type === "image" && typeof data === "string") {
        return [{ type: "image", mime, data }];
      }
      // Audio has no dedicated ContentBlock — surface a faithful text marker.
      return [{ type: "text", text: `[${block.type} ${mime}]` }];
    }
    case "resource": {
      const res = block["resource"] as Record<string, unknown> | undefined;
      if (res && typeof res["text"] === "string") {
        return [{ type: "text", text: res["text"] }];
      }
      const uri = res && typeof res["uri"] === "string" ? res["uri"] : "";
      return [{ type: "text", text: `[resource ${uri}]` }];
    }
    case "resource_link": {
      const uri = typeof block["uri"] === "string" ? block["uri"] : "";
      const name = typeof block["name"] === "string" ? block["name"] : uri;
      return [{ type: "text", text: `[resource_link ${name} ${uri}]` }];
    }
    default:
      return [{ type: "text", text: `[${block.type}]` }];
  }
}

/** Flatten an MCP call result's content array into normalized `ContentBlock`s. */
export function mapMcpContentBlocks(blocks: McpContentBlock[]): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const b of blocks) out.push(...mapMcpContent(b));
  return out;
}

/**
 * Wrap a single discovered MCP tool as a `Tool`. `run()` validates nothing
 * locally beyond object-shaping (the server re-validates against its own schema)
 * and forwards `ctx.signal` + timeout so cancellation and budgets are honored.
 */
export function mcpToolToTool(
  client: McpClient,
  descriptor: McpToolDescriptor,
  opts?: BridgeOptions,
): Tool {
  const name = bridgedToolName(client.name, descriptor.name, opts);
  const trustAnnotations = opts?.trustAnnotations ?? client.trustAnnotations;
  const permission = opts?.permission ?? classifyPermission(descriptor, { trustAnnotations });
  const parameters = (descriptor.inputSchema ?? { type: "object" }) as Record<string, unknown>;

  return {
    name,
    description: descriptor.description ?? `MCP tool "${descriptor.name}" on server "${client.name}"`,
    parameters,
    permission,
    async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
      const args =
        input && typeof input === "object" && !Array.isArray(input)
          ? (input as Record<string, unknown>)
          : {};
      const reqOpts: { signal?: AbortSignal } = {};
      if (ctx.signal) reqOpts.signal = ctx.signal;
      const result = await client.callTool(descriptor.name, args, reqOpts);
      const content = mapMcpContentBlocks(result.content);
      const isError = result.isError === true;
      return isError ? { ok: false, content, isError: true } : { ok: true, content };
    },
  };
}

/** Discover a connected client's tools and wrap them all as `Tool`s. */
export async function bridgeClientTools(
  client: McpClient,
  opts?: BridgeOptions,
): Promise<Tool[]> {
  const descriptors = await client.listTools();
  return descriptors.map((d) => mcpToolToTool(client, d, opts));
}
