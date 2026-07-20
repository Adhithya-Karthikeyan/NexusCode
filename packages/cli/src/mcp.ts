/**
 * MCP wiring for the CLI (system-spec §7). Declared MCP servers live in the
 * NexusCode config (`config.mcp`); at session/engine startup we connect every
 * enabled server, discover its tools, and bridge each discovered tool into the
 * `ToolRegistry` so the native agent tool-loop can call it across ANY provider —
 * all under the same `PermissionGate`.
 *
 * Everything here degrades gracefully (hard rule): one unreachable server never
 * aborts the rest, and with no servers declared the whole subsystem is a no-op.
 * Auth material for remote servers is resolved through the `SecretStore` (which
 * satisfies `@nexuscode/mcp`'s structural `SecretResolver`), so a token only
 * ever lives in memory.
 */

import {
  McpClientManager,
  mcpToolToTool,
  type DiscoveredTool,
  type McpServerConfig as McpManagerServerConfig,
} from "@nexuscode/mcp";
import type { NexusConfig, SecretStore } from "@nexuscode/config";
import type { ToolRegistry } from "@nexuscode/tools";

/** Per-server connection + discovery outcome, for `doctor` / `mcp tools`. */
export interface McpServerReport {
  name: string;
  transport: string;
  connected: boolean;
  /** Number of tools discovered on this server (0 when unreachable). */
  toolCount: number;
  /** Failure detail when `connected` is false. */
  error?: string;
}

/** The live MCP session: the manager (own its lifecycle) + what it discovered. */
export interface McpSession {
  manager: McpClientManager;
  reports: McpServerReport[];
  tools: DiscoveredTool[];
  /** Close every connected client. Safe to call when nothing connected. */
  close(): Promise<void>;
}

/** The enabled MCP servers declared in the config. */
export function enabledMcpServers(config: NexusConfig): NexusConfig["mcp"] {
  return config.mcp.filter((s) => s.enabled);
}

/**
 * Build a manager from the config's enabled MCP servers, connect them all
 * (gracefully), and discover their tools. Returns a session the caller disposes.
 * With no enabled servers this connects nothing and returns empty reports.
 */
export async function startMcpSession(
  config: NexusConfig,
  secrets: SecretStore,
): Promise<McpSession> {
  const manager = new McpClientManager(secrets);
  const servers = enabledMcpServers(config);
  const transportOf = new Map<string, string>();
  for (const s of servers) {
    transportOf.set(s.name, s.transport);
    // Config's McpServerConfig is structurally identical to the mcp package's.
    manager.add(s as unknown as McpManagerServerConfig);
  }

  const reports: McpServerReport[] = [];
  let tools: DiscoveredTool[] = [];

  if (servers.length > 0) {
    const outcomes = await manager.connectAll();
    // Discover only from servers that connected; keep per-server tool counts.
    tools = await manager.discoverTools();
    const countByServer = new Map<string, number>();
    for (const t of tools) countByServer.set(t.server, (countByServer.get(t.server) ?? 0) + 1);
    for (const o of outcomes) {
      const report: McpServerReport = {
        name: o.name,
        transport: transportOf.get(o.name) ?? "?",
        connected: o.ok,
        toolCount: countByServer.get(o.name) ?? 0,
      };
      if (!o.ok) report.error = errorMessage(o.error);
      reports.push(report);
    }
  }

  return {
    manager,
    reports,
    tools,
    close: () => manager.closeAll(),
  };
}

/**
 * Register every discovered MCP tool into `registry` as a bridged `Tool`
 * (server-namespaced so two servers can expose the same tool name). Returns the
 * number of tools actually registered (collisions with existing names are
 * skipped rather than throwing, so built-ins always win).
 */
export function registerMcpTools(registry: ToolRegistry, tools: DiscoveredTool[]): number {
  let registered = 0;
  for (const dt of tools) {
    const tool = mcpToolToTool(dt.client, dt.descriptor);
    if (registry.has(tool.name)) continue;
    registry.register(tool);
    registered++;
  }
  return registered;
}

/**
 * One-call helper for the agentic commands: connect the configured MCP servers,
 * register their tools into `registry`, and return the session (for disposal and
 * reporting). No servers ⇒ a no-op session.
 */
export async function attachMcpTools(
  registry: ToolRegistry,
  config: NexusConfig,
  secrets: SecretStore,
): Promise<McpSession> {
  const session = await startMcpSession(config, secrets);
  registerMcpTools(registry, session.tools);
  return session;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err == null) return "unknown error";
  return String(err);
}
