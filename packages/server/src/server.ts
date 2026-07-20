/**
 * `@nexuscode/server` — the `nexus serve` REST daemon (system-spec §24). It
 * embeds ONE {@link Nexus} (itself a client of the single engine the CLI drives)
 * and exposes the harness over HTTP: start a run, stream its `UiEvent`s live via
 * Server-Sent Events, and introspect providers / tools / sessions / config /
 * health. The daemon is a CLIENT of the engine — it never re-implements
 * orchestration; every route delegates to the SDK facade.
 *
 * Security posture (enforced here):
 *  - Bearer-token auth on every data route; unauthenticated → 401.
 *  - Bound to 127.0.0.1 by default (loopback-only) unless a host is set.
 *  - CORS OFF by default (no `Access-Control-Allow-Origin` emitted).
 *  - `GET /v1/config` is redacted; secrets never leave the process.
 *  - Agent/tool execution is gated by the SDK's PermissionGate (read-only
 *    default) — a stronger mode is honored only with `allowAgentWrite`.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createSecretStore, type SecretStore } from "@nexuscode/config";
import { createNexus, type Nexus, type NexusOptions, type UiEvent } from "@nexuscode/sdk";
import { bearerFrom, resolveAuthToken, tokenMatches } from "./auth.js";
import { redactConfig } from "./redact.js";
import {
  BadRequestError,
  DEFAULT_MAX_CONCURRENT_RUNS,
  DEFAULT_RUN_TIMEOUT_MS,
  RunManager,
  TooManyRunsError,
  type RunRequest,
} from "./runs.js";

/** A principal the server resolves from a bearer token for RBAC. */
export interface ServerPrincipal {
  id: string;
  roles: readonly string[];
}

/**
 * The structural enterprise-enforcement seam (system-spec §25). Supplied by the
 * host (the CLI wires `@nexuscode/enterprise`'s `EnterpriseServices`); the server
 * never imports the enterprise package. When present, every authenticated data
 * request maps its bearer token → principal → role and is authorized per route
 * (403 on deny). The master server token still authenticates as a full-access
 * admin (RBAC bypassed) so first-party clients keep working.
 */
export interface ServerEnterprise {
  /** Resolve the principal a (non-master) bearer token authenticates, or undefined. */
  principalForToken(token: string): ServerPrincipal | undefined;
  /** The RBAC/policy decision for `principal` performing `action` on `resource`. */
  authorize(
    principal: ServerPrincipal,
    action: string,
    resource: string,
  ): { allowed: boolean; reason: string };
  /** Called for every request decision (allow/deny) — e.g. to feed the audit log. */
  audit?(info: {
    principal: ServerPrincipal;
    action: string;
    resource: string;
    allowed: boolean;
    reason: string;
    method: string;
    path: string;
  }): void;
}

/**
 * Map an HTTP request to the RBAC (action, resource) it requires. Mutating a run
 * is an `execute` on `command:run`; a `GET`/`HEAD` is a `read` on a
 * `command:<segment>` resource — so a read-only role (viewer/default) can browse
 * the catalog but cannot start a run. Any OTHER method — a PUT/PATCH/DELETE, or
 * a POST that isn't the one explicitly-mapped read-lookalike above — is fail-
 * closed to a `write` on `command:<segment>`: a FUTURE mutating route that
 * forgets to add its own mapping here still denies a viewer/default role
 * instead of silently falling through to `read` (which they're granted).
 */
export function httpResource(method: string, path: string): { action: string; resource: string } {
  if (method === "POST" && path === "/v1/runs") {
    return { action: "execute", resource: "command:run" };
  }
  const seg = path.replace(/^\/v1\//, "").split("/")[0] || "root";
  const isReadMethod = method === "GET" || method === "HEAD";
  return { action: isReadMethod ? "read" : "write", resource: `command:${seg}` };
}

/** Options for {@link createNexusServer}. */
export interface NexusServerOptions {
  /**
   * An already-built embeddable Nexus. When omitted, one is created from
   * {@link nexusOptions} via the shared runtime bootstrap (engine stays the
   * single source of truth). If you pass a Nexus, the server does NOT dispose it.
   */
  nexus?: Nexus;
  /** Options forwarded to {@link createNexus} when {@link nexus} is omitted. */
  nexusOptions?: NexusOptions;
  /** Explicit bearer token. Else resolved/persisted via the SecretStore. */
  token?: string;
  /** SecretStore backing token bootstrap (defaults to the env→keychain→file chain). */
  secrets?: SecretStore;
  /** Bind host. Defaults to `127.0.0.1` (loopback-only). */
  host?: string;
  /** Bind port. Defaults to `0` (ephemeral) — read {@link NexusServer.address} after `listen`. */
  port?: number;
  /**
   * CORS. `false` (default) emits no CORS headers. `true` allows any origin;
   * a string sets an explicit allowed origin. Only enable for trusted UIs.
   */
  cors?: boolean | string;
  /** Allow run requests to raise the agent permission mode above read-only. */
  allowAgentWrite?: boolean;
  /** Enterprise RBAC/policy enforcement (§25). Omit ⇒ single-token behavior. */
  enterprise?: ServerEnterprise;
  /** Version string surfaced by `GET /v1/health`. */
  version?: string;
  /** Max accepted request-body bytes (default 1 MiB). */
  maxBodyBytes?: number;
  /**
   * Max runs allowed in the `"running"` state at once (default 16). Beyond it,
   * `POST /v1/runs` returns 429 rather than letting unbounded concurrent runs
   * exhaust provider connections / memory.
   */
  maxConcurrentRuns?: number;
  /**
   * Max concurrently open `GET /v1/runs/:id/events` SSE connections (default
   * 64). Beyond it, a new stream request returns 429.
   */
  maxSseConnections?: number;
  /**
   * Wall-clock budget (ms) for a single run before it is cancelled + reaped
   * (default 15 minutes). Guards against an abandoned/stuck run holding a
   * concurrency slot forever.
   */
  runTimeoutMs?: number;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY = 1024 * 1024;
const DEFAULT_MAX_SSE_CONNECTIONS = 64;

/**
 * The embeddable REST daemon. Construct it directly with a live {@link Nexus}
 * and a resolved token, or (preferred) build one via {@link createNexusServer},
 * which also bootstraps the Nexus + token. Call {@link listen} to bind and
 * {@link close} to stop.
 */
export class NexusServer {
  private readonly http: Server;
  private readonly runs: RunManager;
  private readonly startedAt = Date.now();
  private closed = false;
  /** Currently open `GET /v1/runs/:id/events` SSE connections (tracked for the cap + tests). */
  private sseConnections = 0;

  constructor(
    private readonly nexus: Nexus,
    private readonly token: string,
    private readonly opts: {
      host: string;
      port: number;
      cors: boolean | string;
      allowAgentWrite: boolean;
      version: string;
      maxBodyBytes: number;
      maxConcurrentRuns: number;
      maxSseConnections: number;
      runTimeoutMs: number;
      /** Enterprise RBAC enforcement (§25). Undefined ⇒ single-token behavior. */
      enterprise?: ServerEnterprise;
      /** Nexus instances the server owns and disposes on close. */
      ownsNexus: boolean;
    },
  ) {
    this.runs = new RunManager(nexus, opts.allowAgentWrite, {
      maxConcurrentRuns: opts.maxConcurrentRuns,
      runTimeoutMs: opts.runTimeoutMs,
    });
    this.http = createHttpServer((req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.fail(res, 500, "internal_error", err instanceof Error ? err.message : String(err));
      });
    });
  }

  /** Currently open SSE connections (introspection for tests / monitoring). */
  get activeSseConnections(): number {
    return this.sseConnections;
  }

  /** The Node request listener (also usable to mount inside another server / tests). */
  get requestListener(): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
      this.handle(req, res).catch((err: unknown) => {
        this.fail(res, 500, "internal_error", err instanceof Error ? err.message : String(err));
      });
    };
  }

  /** Bind and start accepting connections. Resolves with the bound address. */
  listen(): Promise<AddressInfo> {
    return new Promise((resolve, reject) => {
      this.http.once("error", reject);
      this.http.listen(this.opts.port, this.opts.host, () => {
        this.http.removeListener("error", reject);
        resolve(this.http.address() as AddressInfo);
      });
    });
  }

  /** The bound address, or null before {@link listen} resolves. */
  get address(): AddressInfo | null {
    const a = this.http.address();
    return a && typeof a === "object" ? a : null;
  }

  /** The base URL the server is reachable at (after {@link listen}). */
  get url(): string {
    const a = this.address;
    if (!a) throw new Error("server: not listening");
    const host = a.address === "::" || a.address === "0.0.0.0" ? "127.0.0.1" : a.address;
    return `http://${host.includes(":") ? `[${host}]` : host}:${a.port}`;
  }

  /** The bearer token this server accepts (for wiring a first-party client). */
  get authToken(): string {
    return this.token;
  }

  /** Stop accepting connections and (if owned) dispose the embedded Nexus. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => this.http.close(() => resolve()));
    if (this.opts.ownsNexus) await this.nexus.dispose();
  }

  // ── Request handling ─────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.applyCors(res);

    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    // `GET /v1/health` is a public liveness probe (no secrets, no engine access).
    if (method === "GET" && path === "/v1/health") {
      this.json(res, 200, {
        ok: true,
        version: this.opts.version,
        uptimeMs: Date.now() - this.startedAt,
      });
      return;
    }

    // Everything past this point requires a valid bearer token. When enterprise
    // enforcement is active, a principal bearer token also authenticates (mapped
    // to its role); the master token authenticates as a full-access admin.
    const auth = this.authenticate(req);
    if (!auth.ok) {
      res.setHeader("WWW-Authenticate", "Bearer");
      this.fail(res, 401, "unauthorized", "a valid bearer token is required");
      return;
    }

    // Enterprise RBAC: a non-admin principal is authorized per route (403 on
    // deny). The master token (admin) bypasses RBAC — first-party clients keep
    // full access. Off entirely when no enterprise seam is wired.
    if (this.opts.enterprise && auth.principal) {
      const { action, resource } = httpResource(method, path);
      const decision = this.opts.enterprise.authorize(auth.principal, action, resource);
      this.opts.enterprise.audit?.({
        principal: auth.principal,
        action,
        resource,
        allowed: decision.allowed,
        reason: decision.reason,
        method,
        path,
      });
      if (!decision.allowed) {
        this.fail(res, 403, "forbidden", decision.reason);
        return;
      }
    }

    if (method === "GET" && path === "/v1/providers") {
      this.json(res, 200, { providers: this.nexus.listProviders() });
      return;
    }
    if (method === "GET" && path === "/v1/tools") {
      this.json(res, 200, { tools: this.nexus.listTools() });
      return;
    }
    if (method === "GET" && path === "/v1/config") {
      this.json(res, 200, { config: redactConfig(this.nexus.config) });
      return;
    }
    if (method === "GET" && path === "/v1/sessions") {
      this.json(res, 200, { sessions: this.runs.listSessions() });
      return;
    }
    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path);
    if (method === "GET" && sessionMatch) {
      const rec = this.runs.getSession(decodeURIComponent(sessionMatch[1] as string));
      if (!rec) {
        this.fail(res, 404, "not_found", "no such session");
        return;
      }
      this.json(res, 200, { session: rec });
      return;
    }
    if (method === "GET" && path === "/v1/runs") {
      this.json(res, 200, { runs: this.runs.listRuns() });
      return;
    }
    if (method === "POST" && path === "/v1/runs") {
      await this.postRun(req, res);
      return;
    }
    const runEvents = /^\/v1\/runs\/([^/]+)\/events$/.exec(path);
    if (method === "GET" && runEvents) {
      await this.streamRun(req, res, decodeURIComponent(runEvents[1] as string));
      return;
    }
    const runGet = /^\/v1\/runs\/([^/]+)$/.exec(path);
    if (method === "GET" && runGet) {
      const rec = this.runs.get(decodeURIComponent(runGet[1] as string));
      if (!rec) {
        this.fail(res, 404, "not_found", "no such run");
        return;
      }
      const { run: _run, ...view } = rec;
      this.json(res, 200, { run: view });
      return;
    }

    this.fail(res, 404, "not_found", `no route for ${method} ${path}`);
  }

  private async postRun(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: RunRequest;
    try {
      body = await this.readJson(req);
    } catch (err) {
      this.fail(res, 400, "bad_request", err instanceof Error ? err.message : "invalid JSON body");
      return;
    }
    try {
      const rec = await this.runs.start(body);
      this.json(res, 202, {
        runId: rec.id,
        kind: rec.kind,
        sessionId: rec.sessionId,
        state: rec.state,
        events: `/v1/runs/${rec.id}/events`,
      });
    } catch (err) {
      if (err instanceof BadRequestError) {
        this.fail(res, 400, "bad_request", err.message);
        return;
      }
      if (err instanceof TooManyRunsError) {
        this.fail(res, 429, "too_many_runs", err.message);
        return;
      }
      // A missing/unknown provider or empty backend list is a client error.
      const msg = err instanceof Error ? err.message : String(err);
      if (/not available|requires|at least one/i.test(msg)) {
        this.fail(res, 400, "bad_request", msg);
        return;
      }
      throw err;
    }
  }

  private async streamRun(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
    const rec = this.runs.get(id);
    if (!rec) {
      this.fail(res, 404, "not_found", "no such run");
      return;
    }

    // Resource-exhaustion guard: cap concurrently open SSE connections rather
    // than accepting an unbounded number of long-lived streams.
    if (this.sseConnections >= this.opts.maxSseConnections) {
      this.fail(res, 429, "too_many_connections", "too many open SSE connections; retry later");
      return;
    }
    this.sseConnections++;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Prime the stream so proxies flush headers immediately.
    res.write(`event: open\ndata: ${JSON.stringify({ runId: id, kind: rec.kind })}\n\n`);

    let closedByClient = false;
    let notifyClosed: (() => void) | undefined;
    const closed = new Promise<"closed">((resolve) => {
      notifyClosed = () => resolve("closed");
    });
    const onClose = (): void => {
      closedByClient = true;
      notifyClosed?.();
    };
    req.on("close", onClose);

    // Drive the iterator manually (instead of `for await`) so a client
    // disconnect is observed IMMEDIATELY — raced against the next event —
    // rather than only re-checked between yielded events, which would leave
    // the response and the `close` listener alive until the run's NEXT event
    // (or its end), however far off that is.
    const iterator = (rec.run.events() as AsyncIterable<UiEvent>)[Symbol.asyncIterator]();

    try {
      // `run.events()` replays every buffered UiEvent from the start of the run
      // (the Broadcast is replayable), then follows live — so a late SSE
      // subscriber still receives the full stream.
      for (;;) {
        const winner = await Promise.race([iterator.next(), closed]);
        if (winner === "closed") break;
        if (closedByClient || res.writableEnded) break;
        if (winner.done) break;
        const ev = winner.value;
        res.write(`event: ${ev.t}\ndata: ${JSON.stringify(ev)}\n\n`);
      }
      if (!closedByClient && !res.writableEnded) {
        res.write(`event: end\ndata: ${JSON.stringify({ runId: id, state: rec.state })}\n\n`);
      }
    } catch (err) {
      if (!res.writableEnded && !closedByClient) {
        const message = err instanceof Error ? err.message : String(err);
        res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
      }
    } finally {
      req.removeListener("close", onClose);
      // Best-effort unsubscribe: signals the generator chain to unwind. It may
      // only actually settle once the run itself next advances/ends (the
      // underlying Broadcast has no abort signal of its own) — but this stops
      // US from retaining or consuming it any further, and the connection slot
      // (below) is freed immediately regardless.
      void iterator.return?.(undefined)?.catch(() => {});
      this.sseConnections--;
      if (!res.writableEnded) res.end();
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Authenticate a request. The master token authenticates as a full-access
   * admin (no `principal`, RBAC bypassed). When enterprise enforcement is wired,
   * a principal bearer token also authenticates and carries its principal for
   * the per-route RBAC check. An unrecognized token fails (`ok:false → 401`).
   */
  private authenticate(
    req: IncomingMessage,
  ): { ok: boolean; principal?: ServerPrincipal; admin?: boolean } {
    const presented = bearerFrom(req.headers.authorization);
    if (presented !== null && tokenMatches(presented, this.token)) {
      return { ok: true, admin: true };
    }
    if (this.opts.enterprise && presented !== null) {
      const principal = this.opts.enterprise.principalForToken(presented);
      if (principal) return { ok: true, principal };
    }
    return { ok: false };
  }

  private applyCors(res: ServerResponse): void {
    const { cors } = this.opts;
    if (cors === false) return;
    res.setHeader("Access-Control-Allow-Origin", cors === true ? "*" : cors);
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }

  private readJson(req: IncomingMessage): Promise<RunRequest> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > this.opts.maxBodyBytes) {
          reject(new Error("request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        if (raw.length === 0) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(raw);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            reject(new Error("body must be a JSON object"));
            return;
          }
          resolve(parsed as RunRequest);
        } catch {
          reject(new Error("invalid JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  private json(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  private fail(res: ServerResponse, status: number, code: string, message: string): void {
    if (res.headersSent || res.writableEnded) {
      if (!res.writableEnded) res.end();
      return;
    }
    this.json(res, status, { error: { code, message } });
  }
}

/**
 * Build a ready-to-listen {@link NexusServer}. Reuses the shared runtime
 * bootstrap through {@link createNexus} (unless a `nexus` is supplied), resolves
 * the bearer token via the SecretStore (generating + persisting one on first
 * run), and applies the secure defaults (loopback bind, CORS off, read-only
 * agent gate).
 */
export async function createNexusServer(
  options: NexusServerOptions = {},
): Promise<NexusServer> {
  const secrets = options.secrets ?? createSecretStore();
  const ownsNexus = options.nexus === undefined;
  const nexus = options.nexus ?? (await createNexus(options.nexusOptions ?? {}));

  const { token } = await resolveAuthToken({ token: options.token, secrets });

  return new NexusServer(nexus, token, {
    host: options.host ?? DEFAULT_HOST,
    port: options.port ?? 0,
    cors: options.cors ?? false,
    allowAgentWrite: options.allowAgentWrite ?? false,
    ...(options.enterprise ? { enterprise: options.enterprise } : {}),
    version: options.version ?? "0.0.0",
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY,
    maxConcurrentRuns: options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS,
    maxSseConnections: options.maxSseConnections ?? DEFAULT_MAX_SSE_CONNECTIONS,
    runTimeoutMs: options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
    ownsNexus,
  });
}
