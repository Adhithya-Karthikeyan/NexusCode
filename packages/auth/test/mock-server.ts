/**
 * An in-process MOCK OAuth 2.0 Authorization Server for offline tests. It stands
 * up a real `node:http` server implementing `/authorize` (302s back to the
 * loopback redirect with a code), `/token` (authorization_code / refresh_token /
 * device_code grants), and `/device_authorization` (RFC 8628). It performs REAL
 * PKCE S256 verification and issues opaque tokens — no provider or browser is
 * ever contacted. Test-only; not part of the package build.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function s256(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}
function token(prefix: string): string {
  return `${prefix}-${base64url(randomBytes(24))}`;
}

/**
 * Read a request body as a normalized `URLSearchParams`, accepting EITHER the
 * usual `application/x-www-form-urlencoded` grants (authorize/refresh/device)
 * OR a JSON body (Anthropic's manual-code-paste token exchange — see
 * `exchangeAuthorizationCodeManual` — POSTs JSON, not form-encoded).
 */
async function readBody(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.from(c));
  const text = Buffer.concat(chunks).toString("utf8");
  const contentType = req.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : {};
    const params = new URLSearchParams();
    if (parsed && typeof parsed === "object") {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (v !== undefined && v !== null) params.set(k, String(v));
      }
    }
    return params;
  }
  return new URLSearchParams(text);
}
function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(s);
}

interface AuthzRecord {
  clientId: string;
  redirectUri: string;
  codeChallenge?: string;
  scope: string;
}
interface DeviceRecord {
  clientId: string;
  scope: string;
  polls: number;
  approved: boolean;
}

export interface MockServerOptions {
  clientId?: string;
  /** Number of `authorization_pending` device polls before success (default 2). */
  devicePendingPolls?: number;
  /** Emit a `slow_down` on the first device poll (default false). */
  deviceSlowDownOnce?: boolean;
  /** Access-token lifetime in seconds (default 3600). */
  expiresIn?: number;
  /** Rotate the refresh token on refresh (default false: return the same one). */
  rotateRefresh?: boolean;
}

export interface MockOAuthServer {
  baseUrl: string;
  authorizeUrl: string;
  tokenEndpoint: string;
  deviceEndpoint: string;
  clientId: string;
  /** Approve a pending device authorization immediately (skip poll countdown). */
  approveDevice(userCode: string): void;
  close(): Promise<void>;
}

/** Start the mock server on an ephemeral loopback port. */
export async function startMockOAuthServer(
  opts: MockServerOptions = {},
): Promise<MockOAuthServer> {
  const clientId = opts.clientId ?? "nexuscode-test-client";
  const expiresIn = opts.expiresIn ?? 3600;
  const pendingPolls = opts.devicePendingPolls ?? 2;

  const codes = new Map<string, AuthzRecord>();
  const refreshTokens = new Map<string, string>(); // refresh_token -> scope
  const devices = new Map<string, DeviceRecord>(); // device_code -> record
  const userToDevice = new Map<string, string>(); // user_code -> device_code
  let slowDownArmed = opts.deviceSlowDownOnce ?? false;

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch(() => json(res, 500, { error: "server_error" }));
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    // ── /authorize ── 302 back to the loopback redirect with a fresh code.
    if (url.pathname === "/authorize") {
      const responseType = url.searchParams.get("response_type");
      const cid = url.searchParams.get("client_id");
      const redirectUri = url.searchParams.get("redirect_uri");
      const state = url.searchParams.get("state") ?? "";
      if (responseType !== "code" || cid !== clientId || !redirectUri) {
        json(res, 400, { error: "invalid_request" });
        return;
      }
      const code = token("code");
      const rec: AuthzRecord = {
        clientId: cid,
        redirectUri,
        scope: url.searchParams.get("scope") ?? "",
      };
      const challenge = url.searchParams.get("code_challenge");
      if (challenge) rec.codeChallenge = challenge;
      codes.set(code, rec);
      const loc = new URL(redirectUri);
      loc.searchParams.set("code", code);
      loc.searchParams.set("state", state);
      res.writeHead(302, { location: loc.toString() });
      res.end();
      return;
    }

    // ── /device_authorization ── issue device + user codes.
    if (url.pathname === "/device_authorization" && req.method === "POST") {
      const form = await readBody(req);
      if (form.get("client_id") !== clientId) {
        json(res, 400, { error: "invalid_client" });
        return;
      }
      const deviceCode = token("device");
      const userCode = base64url(randomBytes(4)).slice(0, 8).toUpperCase();
      devices.set(deviceCode, {
        clientId,
        scope: form.get("scope") ?? "",
        polls: 0,
        approved: pendingPolls === 0,
      });
      userToDevice.set(userCode, deviceCode);
      json(res, 200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${baseUrl}/device`,
        verification_uri_complete: `${baseUrl}/device?user_code=${userCode}`,
        expires_in: 900,
        interval: 1,
      });
      return;
    }

    // ── /token ── the three grant types.
    if (url.pathname === "/token" && req.method === "POST") {
      const form = await readBody(req);
      const grant = form.get("grant_type");

      if (grant === "authorization_code") {
        const code = form.get("code") ?? "";
        const rec = codes.get(code);
        if (!rec) {
          json(res, 400, { error: "invalid_grant", error_description: "unknown code" });
          return;
        }
        if (form.get("client_id") !== rec.clientId) {
          json(res, 400, { error: "invalid_client" });
          return;
        }
        if (form.get("redirect_uri") !== rec.redirectUri) {
          json(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
          return;
        }
        // REAL PKCE S256 verification.
        if (rec.codeChallenge) {
          const verifier = form.get("code_verifier") ?? "";
          if (!verifier || s256(verifier) !== rec.codeChallenge) {
            json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
            return;
          }
        }
        codes.delete(code); // single-use
        const refresh = token("refresh");
        refreshTokens.set(refresh, rec.scope);
        json(res, 200, {
          access_token: token("access"),
          refresh_token: refresh,
          token_type: "Bearer",
          expires_in: expiresIn,
          scope: rec.scope,
        });
        return;
      }

      if (grant === "refresh_token") {
        const rt = form.get("refresh_token") ?? "";
        const scope = refreshTokens.get(rt);
        if (scope === undefined) {
          json(res, 400, { error: "invalid_grant", error_description: "unknown refresh token" });
          return;
        }
        const body: Record<string, unknown> = {
          access_token: token("access"),
          token_type: "Bearer",
          expires_in: expiresIn,
          scope,
        };
        if (opts.rotateRefresh) {
          refreshTokens.delete(rt);
          const next = token("refresh");
          refreshTokens.set(next, scope);
          body.refresh_token = next;
        }
        json(res, 200, body);
        return;
      }

      if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
        const dc = form.get("device_code") ?? "";
        const rec = devices.get(dc);
        if (!rec) {
          json(res, 400, { error: "invalid_grant", error_description: "unknown device code" });
          return;
        }
        if (slowDownArmed) {
          slowDownArmed = false;
          json(res, 400, { error: "slow_down" });
          return;
        }
        rec.polls += 1;
        if (!rec.approved && rec.polls >= pendingPolls) rec.approved = true;
        if (!rec.approved) {
          json(res, 400, { error: "authorization_pending" });
          return;
        }
        json(res, 200, {
          access_token: token("access"),
          refresh_token: token("refresh"),
          token_type: "Bearer",
          expires_in: expiresIn,
          scope: rec.scope,
        });
        return;
      }

      json(res, 400, { error: "unsupported_grant_type" });
      return;
    }

    json(res, 404, { error: "not_found" });
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    baseUrl,
    authorizeUrl: `${baseUrl}/authorize`,
    tokenEndpoint: `${baseUrl}/token`,
    deviceEndpoint: `${baseUrl}/device_authorization`,
    clientId,
    approveDevice(userCode: string): void {
      const dc = userToDevice.get(userCode);
      if (dc) {
        const rec = devices.get(dc);
        if (rec) rec.approved = true;
      }
    },
    close(): Promise<void> {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
