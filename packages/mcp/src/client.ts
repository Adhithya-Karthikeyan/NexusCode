/**
 * The MCP client (system-spec §7). One `McpClient` owns a connection to a single
 * MCP server over stdio / SSE / streamable-HTTP and exposes its three primitive
 * surfaces — TOOLS (list + call), RESOURCES (list + read), PROMPTS (list + get)
 * — as plain typed methods. `McpClientManager` fans these across MULTIPLE named
 * servers and provides dynamic discovery (list every tool from every connected
 * server at once).
 *
 * Auth for remote transports is resolved through a `SecretResolver` (the
 * `@nexuscode/config` `SecretStore` satisfies it structurally) at connect time,
 * so a bearer token or header secret only ever lives in memory.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { NexusError } from "@nexuscode/shared";
import type { McpServerConfig } from "./config.js";

/**
 * The subset of `@nexuscode/config`'s `SecretStore` the client needs. Declared
 * structurally so `@nexuscode/mcp` does not depend on `@nexuscode/config`; any
 * object with a `get(ref)` works (including the real chained store).
 */
export interface SecretResolver {
  get(ref: string): Promise<string | null>;
}

/** A single MCP tool as advertised by a server's `tools/list`. */
export interface McpToolDescriptor {
  name: string;
  description?: string;
  /** JSON Schema for the tool's arguments (`type: "object"`). */
  inputSchema: Record<string, unknown>;
  /** Behavioral hints used for permission classification. */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** A resource (or resource template) a server exposes. */
export interface McpResourceDescriptor {
  uri?: string;
  uriTemplate?: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** A prompt template a server exposes. */
export interface McpPromptDescriptor {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** MCP content block (loosely typed; mapped to `ContentBlock` by the bridge). */
export interface McpContentBlock {
  type: string;
  [k: string]: unknown;
}

export interface McpCallToolResult {
  content: McpContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
}

/** Options controlling a single MCP request. */
export interface McpRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const CLIENT_INFO = { name: "nexuscode", version: "0.0.0" } as const;

/**
 * Resolve a declared server config into a live SDK `Transport`, resolving any
 * auth refs through the `SecretResolver`. Exported for tests and for callers
 * that want to build a transport without the full client lifecycle.
 */
export async function resolveTransport(
  config: McpServerConfig,
  secrets?: SecretResolver,
): Promise<Transport> {
  if (config.transport === "stdio") {
    if (!config.command) {
      throw new NexusError("invalid_argument", `mcp "${config.name}": stdio requires a command`);
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      // Merge declared env over the SDK's safe inherited base.
      env: { ...getDefaultEnvironment(), ...config.env },
      stderr: "pipe",
    });
  }

  if (!config.url) {
    throw new NexusError("invalid_argument", `mcp "${config.name}": ${config.transport} requires a url`);
  }
  const url = new URL(config.url);
  const headers = await resolveAuthHeaders(config, secrets);
  const requestInit: RequestInit = Object.keys(headers).length > 0 ? { headers } : {};

  if (config.transport === "sse") {
    return new SSEClientTransport(url, {
      requestInit,
      // Bearer/API headers must also ride the EventSource handshake.
      eventSourceInit: {
        fetch: (input, init) =>
          fetch(input, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }),
      },
    });
  }
  // The concrete transport exposes `sessionId` as `string | undefined`; the
  // `Transport` interface types it as optional. They are structurally the same
  // shape — assert across the exactOptionalPropertyTypes gap.
  return new StreamableHTTPClientTransport(url, { requestInit }) as Transport;
}

/** Resolve `auth.bearerRef` + `auth.headerRefs` (+ static headers) to a header map. */
async function resolveAuthHeaders(
  config: McpServerConfig,
  secrets?: SecretResolver,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = { ...(config.auth?.headers ?? {}) };
  const auth = config.auth;
  if (!auth) return headers;

  if (auth.bearerRef) {
    const token = secrets ? await secrets.get(auth.bearerRef) : null;
    if (!token) {
      throw new NexusError("secret_not_found", `mcp "${config.name}": bearer secret "${auth.bearerRef}" not found`, {
        detail: { server: config.name, ref: auth.bearerRef },
      });
    }
    headers["Authorization"] = `Bearer ${token}`;
  }

  for (const [header, ref] of Object.entries(auth.headerRefs ?? {})) {
    const value = secrets ? await secrets.get(ref) : null;
    if (!value) {
      throw new NexusError("secret_not_found", `mcp "${config.name}": header secret "${ref}" not found`, {
        detail: { server: config.name, ref, header },
      });
    }
    headers[header] = value;
  }
  return headers;
}

/**
 * A live connection to one MCP server. Construct from a config + optional
 * secrets and `connect()`; or hand it a pre-built `Transport` (used by the
 * in-process test harness) via `connectTransport`.
 */
export class McpClient {
  readonly name: string;
  private readonly client: Client;
  private readonly config: McpServerConfig | undefined;
  private readonly secrets: SecretResolver | undefined;
  private readonly trustServerAnnotations: boolean;
  private connected = false;

  constructor(config: McpServerConfig, secrets?: SecretResolver) {
    this.name = config.name;
    this.config = config;
    this.secrets = secrets;
    this.client = new Client(CLIENT_INFO);
    this.trustServerAnnotations = config.trustAnnotations ?? false;
  }

  /**
   * Alternate ctor for a caller that already holds a `Transport` (tests,
   * in-proc). `opts.trustAnnotations` mirrors `McpServerConfig.trustAnnotations`
   * for callers that build a client without a full config; defaults to `false`.
   */
  static withTransport(name: string, opts?: { trustAnnotations?: boolean }): McpClient {
    const c = Object.create(McpClient.prototype) as McpClient;
    Object.assign(c, {
      name,
      client: new Client(CLIENT_INFO),
      config: undefined,
      secrets: undefined,
      connected: false,
      trustServerAnnotations: opts?.trustAnnotations ?? false,
    });
    return c;
  }

  /** True once the MCP `initialize` handshake has completed. */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Whether this server's tool annotations (e.g. `readOnlyHint`) are trusted
   * to auto-downgrade permission classification. Defaults `false` — see
   * `McpServerConfig.trustAnnotations`.
   */
  get trustAnnotations(): boolean {
    return this.trustServerAnnotations;
  }

  private timeout(opts?: McpRequestOptions): number | undefined {
    return opts?.timeoutMs ?? this.config?.timeoutMs;
  }

  private reqOptions(opts?: McpRequestOptions): { signal?: AbortSignal; timeout?: number } {
    const out: { signal?: AbortSignal; timeout?: number } = {};
    if (opts?.signal) out.signal = opts.signal;
    const t = this.timeout(opts);
    if (t !== undefined) out.timeout = t;
    return out;
  }

  /** Connect using this client's config (resolving the transport + auth). */
  async connect(): Promise<void> {
    if (!this.config) {
      throw new NexusError("invalid_argument", `mcp "${this.name}": no config; use connectTransport`);
    }
    const transport = await resolveTransport(this.config, this.secrets);
    await this.connectTransport(transport);
  }

  /** Connect over a caller-supplied transport (in-process / stdio / remote). */
  async connectTransport(transport: Transport): Promise<void> {
    await this.client.connect(transport);
    this.connected = true;
  }

  private ensure(): void {
    if (!this.connected) {
      throw new NexusError("invalid_argument", `mcp "${this.name}": not connected`);
    }
  }

  // ── Tools ────────────────────────────────────────────────────────────────

  async listTools(opts?: McpRequestOptions): Promise<McpToolDescriptor[]> {
    this.ensure();
    const res = await this.client.listTools(undefined, this.reqOptions(opts));
    return res.tools.map((t) => {
      const d: McpToolDescriptor = {
        name: t.name,
        inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      };
      if (t.description !== undefined) d.description = t.description;
      if (t.annotations !== undefined) {
        d.annotations = t.annotations as NonNullable<McpToolDescriptor["annotations"]>;
      }
      return d;
    });
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    opts?: McpRequestOptions,
  ): Promise<McpCallToolResult> {
    this.ensure();
    const res = await this.client.callTool({ name, arguments: args }, undefined, this.reqOptions(opts));
    const out: McpCallToolResult = {
      content: ((res.content ?? []) as unknown[]).map((c) => c as McpContentBlock),
    };
    if (res.isError !== undefined) out.isError = res.isError as boolean;
    if (res.structuredContent !== undefined) out.structuredContent = res.structuredContent;
    return out;
  }

  // ── Resources ──────────────────────────────────────────────────────────────

  async listResources(opts?: McpRequestOptions): Promise<McpResourceDescriptor[]> {
    this.ensure();
    const res = await this.client.listResources(undefined, this.reqOptions(opts));
    return (res.resources ?? []).map((r) => r as McpResourceDescriptor);
  }

  async listResourceTemplates(opts?: McpRequestOptions): Promise<McpResourceDescriptor[]> {
    this.ensure();
    const res = await this.client.listResourceTemplates(undefined, this.reqOptions(opts));
    return (res.resourceTemplates ?? []).map((r) => r as McpResourceDescriptor);
  }

  async readResource(uri: string, opts?: McpRequestOptions): Promise<McpContentBlock[]> {
    this.ensure();
    const res = await this.client.readResource({ uri }, this.reqOptions(opts));
    return ((res.contents ?? []) as unknown[]).map((c) => c as McpContentBlock);
  }

  // ── Prompts ────────────────────────────────────────────────────────────────

  async listPrompts(opts?: McpRequestOptions): Promise<McpPromptDescriptor[]> {
    this.ensure();
    const res = await this.client.listPrompts(undefined, this.reqOptions(opts));
    return (res.prompts ?? []).map((p) => p as McpPromptDescriptor);
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
    opts?: McpRequestOptions,
  ): Promise<{ description?: string; messages: unknown[] }> {
    this.ensure();
    const res = await this.client.getPrompt({ name, arguments: args ?? {} }, this.reqOptions(opts));
    const out: { description?: string; messages: unknown[] } = { messages: res.messages ?? [] };
    if (res.description !== undefined) out.description = res.description;
    return out;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }
}

/** A discovered tool paired with the client that can call it. */
export interface DiscoveredTool {
  server: string;
  descriptor: McpToolDescriptor;
  client: McpClient;
}

/**
 * Owns many named `McpClient`s. Register servers once, connect them, and
 * discover every tool across all of them — the shape the engine binds to so a
 * single tool loop can reach any MCP server behind any provider.
 */
export class McpClientManager {
  private readonly clients = new Map<string, McpClient>();
  private readonly secrets: SecretResolver | undefined;

  constructor(secrets?: SecretResolver) {
    this.secrets = secrets;
  }

  /** Register a server declaration (does not connect). Throws on duplicate name. */
  add(config: McpServerConfig): McpClient {
    if (this.clients.has(config.name)) {
      throw new NexusError("invalid_argument", `duplicate mcp server: ${config.name}`);
    }
    const client = new McpClient(config, this.secrets);
    this.clients.set(config.name, client);
    return client;
  }

  /** Register an already-built client (used by the in-process test harness). */
  addClient(client: McpClient): void {
    if (this.clients.has(client.name)) {
      throw new NexusError("invalid_argument", `duplicate mcp server: ${client.name}`);
    }
    this.clients.set(client.name, client);
  }

  has(name: string): boolean {
    return this.clients.has(name);
  }

  get(name: string): McpClient {
    const c = this.clients.get(name);
    if (!c) throw new NexusError("invalid_argument", `no mcp server "${name}"`);
    return c;
  }

  list(): McpClient[] {
    return [...this.clients.values()];
  }

  names(): string[] {
    return [...this.clients.keys()];
  }

  /**
   * Connect every registered server whose config is `enabled`. Returns per-server
   * outcomes so one unreachable server does not abort the rest (graceful).
   */
  async connectAll(): Promise<{ name: string; ok: boolean; error?: unknown }[]> {
    const results: { name: string; ok: boolean; error?: unknown }[] = [];
    for (const client of this.clients.values()) {
      if (client.isConnected()) {
        results.push({ name: client.name, ok: true });
        continue;
      }
      try {
        await client.connect();
        results.push({ name: client.name, ok: true });
      } catch (error) {
        results.push({ name: client.name, ok: false, error });
      }
    }
    return results;
  }

  /** Dynamic discovery: list every tool from every connected server. */
  async discoverTools(opts?: McpRequestOptions): Promise<DiscoveredTool[]> {
    const out: DiscoveredTool[] = [];
    for (const client of this.clients.values()) {
      if (!client.isConnected()) continue;
      const tools = await client.listTools(opts);
      for (const descriptor of tools) out.push({ server: client.name, descriptor, client });
    }
    return out;
  }

  async closeAll(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
  }
}
