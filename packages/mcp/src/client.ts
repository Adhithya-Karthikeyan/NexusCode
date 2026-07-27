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
 * Bound for the connect + `initialize` handshake when a server declares no
 * `timeoutMs` of its own. The MCP SDK already applies its own 60s default to
 * the `initialize` REQUEST once the transport is up, but that leaves the
 * transport's own startup (spawning a stdio child, opening a socket) — which
 * happens BEFORE any request-level timeout is even armed — completely
 * unbounded. A stdio server that spawns but stalls before speaking MCP (a
 * slow cold start, or one blocked acquiring a lock held by another already-
 * running instance of itself) would otherwise hang the whole command
 * forever with no output. `McpClient.connectTransport` below races the
 * ENTIRE connect (transport start + handshake) against this bound via
 * `withTimeout`, regardless of which layer stalls.
 */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Race `work` against `ms`; on timeout, AWAIT `onTimeout` (cleanup — e.g.
 * closing a half-connected client so a stalled child is not leaked) before
 * rejecting with a clear, actionable error instead of hanging.
 *
 * `onTimeout` is awaited, not fire-and-forget: an earlier version fired it
 * without waiting, which let the caller's process exit (or the caller move
 * on) before the underlying `StdioClientTransport.close()`'s SIGTERM→SIGKILL
 * sequence finished — silently leaking the stalled child forever instead of
 * ending it. That is the exact failure this whole timeout exists to prevent,
 * just moved one layer down. `onTimeout` itself must never be able to hang —
 * `McpClient.connectTransport` passes `client.close()`, which already bounds
 * itself to a few seconds even in the worst case (SDK-internal).
 */
function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => Promise<void>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void onTimeout()
        .catch(() => undefined)
        .then(() => reject(new NexusError("timeout", message)));
    }, ms);
    work.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

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
  // Only set via `withTransport`'s `opts.timeoutMs` — a full `config.timeoutMs`
  // covers the normal (declared-server) construction path.
  private readonly explicitTimeoutMs: number | undefined;
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
   * `opts.timeoutMs` overrides the connect timeout the same way a declared
   * server's `config.timeoutMs` would — mainly so tests can exercise a bounded
   * connect against an unresponsive in-process peer without waiting out
   * `DEFAULT_CONNECT_TIMEOUT_MS`.
   */
  static withTransport(name: string, opts?: { trustAnnotations?: boolean; timeoutMs?: number }): McpClient {
    const c = Object.create(McpClient.prototype) as McpClient;
    Object.assign(c, {
      name,
      client: new Client(CLIENT_INFO),
      config: undefined,
      secrets: undefined,
      connected: false,
      trustServerAnnotations: opts?.trustAnnotations ?? false,
      explicitTimeoutMs: opts?.timeoutMs,
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
    return opts?.timeoutMs ?? this.config?.timeoutMs ?? this.explicitTimeoutMs;
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
    const ms = this.timeout() ?? DEFAULT_CONNECT_TIMEOUT_MS;
    await withTimeout(
      this.client.connect(transport, { timeout: ms }),
      ms,
      // Awaited by `withTimeout` before it rejects: drop the half-connected
      // client so a stalled spawned child/socket is actually killed (the SDK's
      // stdio transport SIGTERMs then SIGKILLs it) rather than merely
      // abandoned to run forever. Never lets a broken close() re-hang us —
      // `withTimeout` still settles even if this rejects.
      () => this.client.close().catch(() => undefined),
      `mcp "${this.name}": connect timed out after ${ms}ms (server did not complete the MCP handshake in time)`,
    );
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
   *
   * Connects run CONCURRENTLY, each individually bounded (see `connectTransport`'s
   * `withTimeout`): a stalled server costs at most its own timeout, never the sum
   * of every server's timeout, and never blocks another server's connect.
   */
  async connectAll(): Promise<{ name: string; ok: boolean; error?: unknown }[]> {
    const clients = [...this.clients.values()];
    const settled = await Promise.allSettled(
      clients.map(async (client) => {
        if (!client.isConnected()) await client.connect();
      }),
    );
    return settled.map((outcome, i) => {
      const client = clients[i]!;
      if (outcome.status === "fulfilled") return { name: client.name, ok: true };
      return { name: client.name, ok: false, error: outcome.reason };
    });
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
