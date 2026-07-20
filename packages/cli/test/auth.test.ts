/**
 * Wave-13 CLI auth wiring — `nexus login` / `logout` / `auth status` and the
 * runtime credential resolution, exercised OFFLINE against the in-process MOCK
 * OAuth authorization server (packages/auth's `startMockOAuthServer`). No real
 * browser and no real provider auth server is ever contacted: a `browserSim`
 * follows the mock AS's 302 back to the loopback redirect, and the token
 * exchange/refresh hit the mock server over 127.0.0.1.
 *
 * Covers the task's checklist:
 *  - `auth status` shows not-logged-in initially;
 *  - a login against the mock AS stores a token and `auth status` then shows
 *    logged-in with an expiry;
 *  - `logout` clears it;
 *  - the runtime resolves an OAuth Bearer for a logged-in provider;
 *  - the api-key path still works (guided key capture → stored → resolvable).
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NexusConfig, createSecretStore, type SecretStore } from "@nexuscode/config";
import { buildRuntime } from "@nexuscode/runtime";
import { ANTHROPIC_OAUTH_CONFIG } from "@nexuscode/auth";
import { startMockOAuthServer, type MockOAuthServer } from "../../auth/test/mock-server.js";
import {
  cmdAuth,
  cmdLogin,
  cmdLogout,
  type AuthCommandDeps,
  type Io,
} from "../src/commands.js";
import { buildAuthRegistry } from "../src/auth.js";
import type { ParsedArgs } from "../src/args.js";

// ── helpers ──────────────────────────────────────────────────────────────────

function makeIo(): { io: Io; stdout: () => string; stderr: () => string } {
  let out = "";
  let err = "";
  return {
    io: { out: (s) => (out += s), err: (s) => (err += s) },
    stdout: () => out,
    stderr: () => err,
  };
}

function args(positionals: string[] = [], bools: string[] = []): ParsedArgs {
  return { positionals, flags: new Map(), multi: new Map(), bools: new Set(bools) };
}

/** A disk-backed SecretStore (keychain disabled) under a throwaway temp file. */
function tempSecrets(): { secrets: SecretStore; cleanup: () => void } {
  const filePath = join(tmpdir(), `nexus-cli-auth-${randomBytes(8).toString("hex")}.json`);
  const secrets = createSecretStore({
    disableKeychain: true,
    filePath,
    passphrase: "test-passphrase",
    envVarFor: () => undefined,
  });
  return { secrets, cleanup: () => rmSync(filePath, { force: true }) };
}

/**
 * Simulate the browser: GET the authorize URL, follow the mock AS's 302 back to
 * the loopback redirect the login flow started. No real browser is opened.
 */
function browserSim(): (url: string) => Promise<boolean> {
  return async (url: string): Promise<boolean> => {
    const r = await fetch(url, { redirect: "manual" });
    const loc = r.headers.get("location");
    if (!loc) return false;
    await fetch(loc);
    return true;
  };
}

/**
 * Simulate the browser for Anthropic's manual-code-paste flow (`nexus login
 * anthropic` now uses `ANTHROPIC_OAUTH_CONFIG.manualCode`, not a loopback
 * redirect): GET the authorize URL and read the mock AS's 302 Location — which
 * carries `code` + `state` appended to the FIXED (non-loopback) redirect_uri —
 * WITHOUT fetching it (in production that's a real callback PAGE, not a server
 * this test could hit). `readCode` hands back the `code#state` string a user
 * would paste into the CLI.
 */
function manualCodeSim(): {
  openBrowser: (url: string) => Promise<boolean>;
  readCode: () => Promise<string>;
} {
  let pasted = "";
  return {
    openBrowser: async (url: string): Promise<boolean> => {
      const r = await fetch(url, { redirect: "manual" });
      const loc = r.headers.get("location");
      if (!loc) return false;
      const target = new URL(loc);
      pasted = `${target.searchParams.get("code") ?? ""}#${target.searchParams.get("state") ?? ""}`;
      return true;
    },
    readCode: async (): Promise<string> => pasted,
  };
}

/** A config whose Anthropic OAuth endpoints point at the mock AS + an anthropic provider. */
function configFor(server: MockOAuthServer): NexusConfig {
  return NexusConfig.parse({
    defaultProvider: "anthropic",
    providers: [{ id: "anthropic", kind: "anthropic", adapter: "@nexuscode/provider-anthropic" }],
    auth: {
      providers: {
        anthropic: {
          clientId: server.clientId,
          authorizeUrl: server.authorizeUrl,
          tokenEndpoint: server.tokenEndpoint,
          scopes: ANTHROPIC_OAUTH_CONFIG.scopes,
        },
      },
    },
  });
}

// ── suite ────────────────────────────────────────────────────────────────────

describe("nexus auth — login/logout/status against the mock OAuth server", () => {
  let server: MockOAuthServer;
  let secretsCtx: { secrets: SecretStore; cleanup: () => void };

  beforeEach(async () => {
    server = await startMockOAuthServer({ clientId: "nexus-cli-test-client", expiresIn: 3600 });
    secretsCtx = tempSecrets();
  });
  afterEach(async () => {
    secretsCtx.cleanup();
    await server.close();
  });

  it("`auth status` shows not-logged-in initially", async () => {
    const config = configFor(server);
    const deps: AuthCommandDeps = { config, secrets: secretsCtx.secrets, openBrowser: browserSim() };
    const { io, stdout } = makeIo();

    const code = await cmdAuth(args(["status"]), io, deps);

    expect(code).toBe(0);
    expect(stdout()).toContain("auth status:");
    // Anthropic is present but not signed in yet.
    const anthropicLine = stdout()
      .split("\n")
      .find((l) => l.includes("anthropic"));
    expect(anthropicLine).toBeDefined();
    expect(anthropicLine).toContain("not signed in");
  });

  it("login stores a token; `auth status` then shows logged-in with an expiry", async () => {
    const config = configFor(server);
    const sim = manualCodeSim();
    const deps: AuthCommandDeps = {
      config,
      secrets: secretsCtx.secrets,
      openBrowser: sim.openBrowser,
      readCode: sim.readCode,
    };

    // Login via the REAL manual-code-paste flow (mock AS) — "login like Claude Code".
    const loginIo = makeIo();
    const loginCode = await cmdLogin(args(["anthropic"]), loginIo.io, deps);
    expect(loginCode).toBe(0);
    expect(loginIo.stdout()).toContain("signed in to anthropic");
    // A token value must NEVER be printed.
    expect(loginIo.stdout()).not.toMatch(/access-/);
    expect(loginIo.stderr()).not.toMatch(/access-/);

    // Status now reports logged-in with a relative expiry (~60m for 3600s).
    const statusIo = makeIo();
    const statusCode = await cmdAuth(args(["status"]), statusIo.io, deps);
    expect(statusCode).toBe(0);
    const line = statusIo
      .stdout()
      .split("\n")
      .find((l) => l.includes("anthropic"));
    expect(line).toContain("oauth");
    expect(line).toContain("expires");
  });

  it("`logout` clears the stored token", async () => {
    const config = configFor(server);
    const sim = manualCodeSim();
    const deps: AuthCommandDeps = {
      config,
      secrets: secretsCtx.secrets,
      openBrowser: sim.openBrowser,
      readCode: sim.readCode,
    };

    await cmdLogin(args(["anthropic"]), makeIo().io, deps);

    const outIo = makeIo();
    const logoutCode = await cmdLogout(args(["anthropic"]), outIo.io, deps);
    expect(logoutCode).toBe(0);
    expect(outIo.stdout()).toContain("logged out of anthropic");

    const statusIo = makeIo();
    await cmdAuth(args(["status"]), statusIo.io, deps);
    const line = statusIo
      .stdout()
      .split("\n")
      .find((l) => l.includes("anthropic"));
    expect(line).toContain("not signed in");
  });

  it("the runtime resolves an OAuth Bearer for a logged-in provider", async () => {
    const config = configFor(server);
    const sim = manualCodeSim();
    const deps: AuthCommandDeps = {
      config,
      secrets: secretsCtx.secrets,
      openBrowser: sim.openBrowser,
      readCode: sim.readCode,
    };

    await cmdLogin(args(["anthropic"]), makeIo().io, deps);

    // The SAME auth registry the runtime is wired with must now resolve a Bearer.
    const authRegistry = buildAuthRegistry(config, secretsCtx.secrets, { openBrowser: browserSim() });
    const resolved = await authRegistry.get("anthropic")!.resolveCredential();
    expect(resolved.kind).toBe("bearer");
    expect(resolved.value.length).toBeGreaterThan(0);

    // buildRuntime wired with that registry registers the anthropic adapter.
    const runtime = await buildRuntime(config, { secrets: secretsCtx.secrets, authRegistry });
    expect(runtime.registry.has("anthropic")).toBe(true);
  });

  it("the api-key path still works (guided key capture → stored → resolvable)", async () => {
    // OpenAI authenticates by key (honest api-key strategy — never faked OAuth).
    const config = NexusConfig.parse({
      providers: [{ id: "openai", kind: "openai-compat", adapter: "@nexuscode/provider-openai" }],
    });
    const deps: AuthCommandDeps = {
      config,
      secrets: secretsCtx.secrets,
      readKey: async () => "sk-test-openai-key",
    };

    const io = makeIo();
    const code = await cmdLogin(args(["openai"]), io.io, deps);
    expect(code).toBe(0);
    expect(io.stdout()).toContain("signed in to openai");
    expect(io.stdout()).toContain("api-key");

    // The key landed in the SecretStore under the provider ref and is resolvable.
    expect(await secretsCtx.secrets.get("openai")).toBe("sk-test-openai-key");

    const authRegistry = buildAuthRegistry(config, secretsCtx.secrets);
    const resolved = await authRegistry.get("openai")!.resolveCredential();
    expect(resolved.kind).toBe("api-key");
    expect(resolved.value).toBe("sk-test-openai-key");

    const statusIo = makeIo();
    await cmdAuth(args(["status"]), statusIo.io, deps);
    const line = statusIo
      .stdout()
      .split("\n")
      .find((l) => /\]\s*openai\s*—/.test(l));
    expect(line).toContain("api-key");
  });
});
