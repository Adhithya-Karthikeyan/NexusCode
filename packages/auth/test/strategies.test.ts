import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createSecretStore, type SecretStore } from "@nexuscode/config";
import {
  createAnthropicAuthStrategy,
  createApiKeyStrategy,
  createCliDelegateStrategy,
  createCloudSsoStrategy,
  createGoogleAuthStrategy,
  createDefaultAuthRegistry,
  ProviderAuthRegistry,
  awsCredsPresent,
  ANTHROPIC_OAUTH_CONFIG,
  type StrategyExec,
  type CommandResult,
  type OAuthProviderConfig,
} from "@nexuscode/auth";
import { startMockOAuthServer, type MockOAuthServer } from "./mock-server.js";

// ── helpers ────────────────────────────────────────────────────────────────

/** A disk-backed SecretStore (keychain disabled) under a throwaway temp file. */
function tempSecretStore(env: NodeJS.ProcessEnv = {}): { secrets: SecretStore; cleanup: () => void } {
  const filePath = join(tmpdir(), `nexus-auth-test-${randomBytes(8).toString("hex")}.json`);
  const secrets = createSecretStore({
    disableKeychain: true,
    filePath,
    passphrase: "test-passphrase",
    env,
    // Map any ref to a nonexistent env var so only the file backend answers.
    envVarFor: () => undefined,
  });
  return { secrets, cleanup: () => rmSync(filePath, { force: true }) };
}

/** Anthropic OAuth config pointed at the in-process mock authorization server. */
function anthropicOauthConfigFor(server: MockOAuthServer): OAuthProviderConfig {
  return {
    ...ANTHROPIC_OAUTH_CONFIG,
    authorizeUrl: server.authorizeUrl,
    tokenEndpoint: server.tokenEndpoint,
    clientId: server.clientId,
  };
}

/**
 * Simulate the browser: GET the authorize URL, follow the mock AS's 302 back to
 * the loopback redirect. No real browser is ever opened.
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
 * Simulate the browser for Anthropic's manual-code-paste flow: GET the
 * authorize URL and read the mock AS's 302 Location — which carries `code` +
 * `state` appended to the FIXED (non-loopback) Anthropic redirect_uri — WITHOUT
 * ever fetching that URL (in production it's a real `platform.claude.com`
 * page, not a server we can hit). Hands back the `code#state` string a user
 * would paste, via `readCode`.
 */
function manualCodeBrowserSim(): {
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

/** A fully in-memory fake exec for cli-delegate / cloud-sso tests (offline). */
function fakeExec(init: {
  bins?: Set<string>;
  files?: Set<string>;
  home?: string;
  runResult?: (bin: string, args: string[]) => CommandResult;
}): StrategyExec & { runs: Array<{ bin: string; args: string[] }> } {
  const bins = init.bins ?? new Set<string>();
  const files = init.files ?? new Set<string>();
  const home = init.home ?? "/home/tester";
  const runs: Array<{ bin: string; args: string[] }> = [];
  return {
    runs,
    which: (bin) => bins.has(bin),
    fileExists: (path) => files.has(path),
    home: () => home,
    run: async (bin, args) => {
      runs.push({ bin, args });
      return init.runResult ? init.runResult(bin, args) : { code: 0, stdout: "", stderr: "" };
    },
  };
}

// ── OAuth (Anthropic "login like Claude Code") ───────────────────────────────

describe("Anthropic OAuth strategy (login like Claude Code)", () => {
  let server: MockOAuthServer;
  beforeEach(async () => {
    server = await startMockOAuthServer();
  });
  afterEach(async () => {
    await server.close();
  });

  it("builds the correct authorize URL, exchanges via the mock AS, and resolves a Bearer credential", async () => {
    const { secrets, cleanup } = tempSecretStore();
    try {
      const strat = createAnthropicAuthStrategy({
        secrets,
        oauthConfig: anthropicOauthConfigFor(server),
        fetchImpl: fetch,
      });

      // Before login: not logged in.
      const before = await strat.status();
      expect(before.loggedIn).toBe(false);
      expect(before.kind).toBe("oauth");

      const sim = manualCodeBrowserSim();
      const urls: string[] = [];
      const status = await strat.login({
        method: "oauth",
        openBrowser: sim.openBrowser,
        readCode: sim.readCode,
        onAuthorizeUrl: (u) => urls.push(u),
        timeoutMs: 5000,
      });

      // The authorize URL carried PKCE (S256) + state + the manual-code paste
      // params (`code=true` and the FIXED, non-loopback Anthropic redirect_uri)
      // and the real Anthropic account scopes — EXACTLY what Claude Code's own
      // CLI sends.
      expect(urls).toHaveLength(1);
      const au = new URL(urls[0] as string);
      expect(au.searchParams.get("code_challenge_method")).toBe("S256");
      expect(au.searchParams.get("code_challenge")).toBeTruthy();
      expect(au.searchParams.get("state")).toBeTruthy();
      expect(au.searchParams.get("code")).toBe("true");
      expect(au.searchParams.get("redirect_uri")).toBe(
        "https://platform.claude.com/oauth/code/callback",
      );
      expect(au.searchParams.get("scope")).toContain("user:inference");

      expect(status.loggedIn).toBe(true);
      expect(status.method).toBe("oauth (Claude account)");

      // resolveCredential returns the OAuth access token as a Bearer.
      const cred = await strat.resolveCredential();
      expect(cred.kind).toBe("bearer");
      expect(cred.value).toMatch(/^access-/);
      expect(cred.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      cleanup();
    }
  });

  it("auto-refreshes a near-expiry access token on resolveCredential", async () => {
    const { secrets, cleanup } = tempSecretStore();
    try {
      // Very short-lived tokens so the very next resolve triggers a refresh.
      const shortServer = await startMockOAuthServer({ expiresIn: 1 });
      try {
        let clock = Date.now();
        const strat = createAnthropicAuthStrategy({
          secrets,
          oauthConfig: anthropicOauthConfigFor(shortServer),
          fetchImpl: fetch,
          now: () => clock,
        });
        const sim = manualCodeBrowserSim();
        await strat.login({
          method: "oauth",
          openBrowser: sim.openBrowser,
          readCode: sim.readCode,
          timeoutMs: 5000,
        });
        const first = await strat.resolveCredential();
        // Advance the clock beyond expiry+skew so the next read must refresh.
        clock += 10 * 60_000;
        const second = await strat.resolveCredential();
        expect(second.kind).toBe("bearer");
        expect(second.value).toMatch(/^access-/);
        // A refresh minted a NEW access token.
        expect(second.value).not.toBe(first.value);
      } finally {
        await shortServer.close();
      }
    } finally {
      cleanup();
    }
  });

  it("logout clears the stored token so status reports logged-out", async () => {
    const { secrets, cleanup } = tempSecretStore();
    try {
      const strat = createAnthropicAuthStrategy({
        secrets,
        oauthConfig: anthropicOauthConfigFor(server),
        fetchImpl: fetch,
      });
      const sim = manualCodeBrowserSim();
      await strat.login({
        method: "oauth",
        openBrowser: sim.openBrowser,
        readCode: sim.readCode,
        timeoutMs: 5000,
      });
      expect((await strat.status()).loggedIn).toBe(true);
      await strat.logout();
      const after = await strat.status();
      expect(after.loggedIn).toBe(false);
      expect((await strat.resolveCredential()).kind).toBe("none");
    } finally {
      cleanup();
    }
  });

  it("falls back to the api-key alternative and resolves it as an api-key credential", async () => {
    const { secrets, cleanup } = tempSecretStore();
    try {
      const strat = createAnthropicAuthStrategy({
        secrets,
        oauthConfig: anthropicOauthConfigFor(server),
        fetchImpl: fetch,
      });
      const status = await strat.login({ method: "api-key", apiKey: "sk-ant-test-console-key" });
      expect(status.loggedIn).toBe(true);
      expect(status.method).toBe("api-key (console key)");
      const cred = await strat.resolveCredential();
      expect(cred.kind).toBe("api-key");
      expect(cred.value).toBe("sk-ant-test-console-key");
    } finally {
      cleanup();
    }
  });

  it("degrades to the api-key when a stale, unrefreshable OAuth token would throw", async () => {
    // A stored OAuth token that is expired AND has no refresh token makes
    // `getFresh` THROW `invalid_grant`. With a valid console key present, the
    // composite must NOT propagate that throw — it must degrade to the api-key
    // (the documented contract). Regression for the uncaught-throw bug.
    const { secrets, cleanup } = tempSecretStore();
    try {
      // Seed a stale, non-refreshable OAuth token directly under the token ref.
      await secrets.set(
        "oauth:anthropic",
        JSON.stringify({
          accessToken: "access-stale",
          expiresAt: Date.now() - 60_000, // already expired
          scope: "user:inference",
          tokenType: "Bearer",
          // NOTE: no refreshToken → getFresh throws invalid_grant.
        }),
      );
      // And a perfectly valid console API key.
      await secrets.set("anthropic", "sk-ant-valid-console-key");

      const strat = createAnthropicAuthStrategy({
        secrets,
        oauthConfig: anthropicOauthConfigFor(server),
        fetchImpl: fetch,
      });
      const cred = await strat.resolveCredential();
      expect(cred.kind).toBe("api-key");
      expect(cred.value).toBe("sk-ant-valid-console-key");
    } finally {
      cleanup();
    }
  });
});

// ── api-key (honest, no faked OAuth) ─────────────────────────────────────────

describe("api-key strategy (honest key auth)", () => {
  it("stores a captured key and resolves it back", async () => {
    const { secrets, cleanup } = tempSecretStore();
    try {
      const strat = createApiKeyStrategy({
        providerId: "openai",
        secrets,
        ref: "openai",
        keyPageUrl: "https://platform.openai.com/api-keys",
        label: "api-key",
      });
      expect(strat.kind).toBe("api-key");
      expect((await strat.status()).loggedIn).toBe(false);

      const pages: string[] = [];
      const status = await strat.login({ apiKey: "sk-openai-xyz", onKeyPage: (u) => pages.push(u) });
      expect(pages).toEqual(["https://platform.openai.com/api-keys"]);
      expect(status.loggedIn).toBe(true);

      const cred = await strat.resolveCredential();
      expect(cred.kind).toBe("api-key");
      expect(cred.value).toBe("sk-openai-xyz");

      await strat.logout();
      expect((await strat.status()).loggedIn).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("captures a key via the lazy readKey callback", async () => {
    const { secrets, cleanup } = tempSecretStore();
    try {
      const strat = createApiKeyStrategy({ providerId: "openai", secrets });
      await strat.login({ readKey: async () => "  sk-piped-key  " });
      expect((await strat.resolveCredential()).value).toBe("sk-piped-key");
    } finally {
      cleanup();
    }
  });

  it("resolves the env var before the store (env-first)", async () => {
    const { secrets, cleanup } = tempSecretStore({ OPENAI_API_KEY: "sk-from-env" });
    try {
      const strat = createApiKeyStrategy({
        providerId: "openai",
        secrets,
        keyEnv: "OPENAI_API_KEY",
        env: { OPENAI_API_KEY: "sk-from-env" },
      });
      const status = await strat.status();
      expect(status.loggedIn).toBe(true);
      expect(status.detail).toContain("env OPENAI_API_KEY");
      expect((await strat.resolveCredential()).value).toBe("sk-from-env");
    } finally {
      cleanup();
    }
  });

  it("throws a clear (non-OAuth) error when no key is provided", async () => {
    const { secrets, cleanup } = tempSecretStore();
    try {
      const strat = createApiKeyStrategy({ providerId: "openai", secrets });
      await expect(strat.login({})).rejects.toThrow(/api-key login, not OAuth/);
    } finally {
      cleanup();
    }
  });
});

// ── cli-delegate (vendor CLI owns its own login) ─────────────────────────────

describe("cli-delegate strategy (wrapped vendor CLI)", () => {
  it("detects an existing vendor-CLI session from its credential file", async () => {
    const exec = fakeExec({
      bins: new Set(["claude"]),
      files: new Set(["/home/tester/.claude/.credentials.json"]),
    });
    const strat = createCliDelegateStrategy({
      spec: {
        providerId: "claude-code",
        bin: "claude",
        label: "Claude Code",
        loginArgs: ["/login"],
        sessionFiles: [".claude/.credentials.json"],
      },
      exec,
    });
    const status = await strat.status();
    expect(status.kind).toBe("cli-delegate");
    expect(status.loggedIn).toBe(true);
    expect(status.detail).toContain("session detected");
    // The wrapped CLI authenticates itself — we inject no credential.
    expect((await strat.resolveCredential()).kind).toBe("none");
  });

  it("reports not-logged-in gracefully when installed but no session exists", async () => {
    const exec = fakeExec({ bins: new Set(["claude"]), files: new Set() });
    const strat = createCliDelegateStrategy({
      spec: { providerId: "claude-code", bin: "claude", loginArgs: ["/login"], sessionFiles: [".claude/.credentials.json"] },
      exec,
    });
    const status = await strat.status();
    expect(status.loggedIn).toBe(false);
    expect(status.detail).toContain("not logged in");
  });

  it("reports not-installed gracefully when the binary is absent", async () => {
    const exec = fakeExec({ bins: new Set(), files: new Set() });
    const strat = createCliDelegateStrategy({
      spec: { providerId: "codex", bin: "codex", loginArgs: ["login"], sessionFiles: [".codex/auth.json"] },
      exec,
    });
    const status = await strat.status();
    expect(status.loggedIn).toBe(false);
    expect(status.detail).toContain("not installed");
    await expect(strat.login()).rejects.toThrow(/not installed/);
  });

  it("delegates login to the vendor CLI's own login subcommand", async () => {
    const files = new Set<string>();
    const exec = fakeExec({
      bins: new Set(["claude"]),
      files,
      runResult: (bin, args) => {
        // Simulate the vendor login writing its credential file on success.
        if (bin === "claude" && args[0] === "/login") files.add("/home/tester/.claude/.credentials.json");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const strat = createCliDelegateStrategy({
      spec: { providerId: "claude-code", bin: "claude", loginArgs: ["/login"], sessionFiles: [".claude/.credentials.json"] },
      exec,
    });
    const status = await strat.login();
    expect(exec.runs).toEqual([{ bin: "claude", args: ["/login"] }]);
    expect(status.loggedIn).toBe(true);
  });
});

// ── cloud-sso (AWS/GCP credential chain) ─────────────────────────────────────

describe("cloud-sso strategy (Bedrock / AWS)", () => {
  it("reports logged-in when the AWS credential chain resolves (env)", async () => {
    const exec = fakeExec({ bins: new Set(["aws"]) });
    const env = { AWS_ACCESS_KEY_ID: "AKIA", AWS_SECRET_ACCESS_KEY: "secret" };
    const strat = createCloudSsoStrategy({
      spec: {
        providerId: "bedrock",
        bin: "aws",
        label: "AWS SSO",
        loginArgs: ["sso", "login"],
        credsPresent: (e) => awsCredsPresent(e, env),
      },
      exec,
    });
    const status = await strat.status();
    expect(status.kind).toBe("cloud-sso");
    expect(status.loggedIn).toBe(true);
    expect((await strat.resolveCredential()).kind).toBe("none");
  });

  it("delegates login to `aws sso login` and reports not-logged-in without creds", async () => {
    const env: NodeJS.ProcessEnv = {};
    const exec = fakeExec({ bins: new Set(["aws"]) });
    const strat = createCloudSsoStrategy({
      spec: {
        providerId: "bedrock",
        bin: "aws",
        label: "AWS SSO",
        loginArgs: ["sso", "login"],
        credsPresent: (e) => awsCredsPresent(e, env),
      },
      exec,
    });
    expect((await strat.status()).loggedIn).toBe(false);
    await strat.login();
    expect(exec.runs).toEqual([{ bin: "aws", args: ["sso", "login"] }]);
  });
});

// ── Google composite (gcloud delegate / OAuth / api-key) ─────────────────────

describe("Google strategy (gemini / vertex)", () => {
  it("prefers gcloud ADC delegation when gcloud is present", async () => {
    const { secrets, cleanup } = tempSecretStore();
    try {
      const exec = fakeExec({ bins: new Set(["gcloud"]) });
      const strat = createGoogleAuthStrategy({ providerId: "vertex", secrets, exec, env: {} });
      await strat.login();
      expect(exec.runs).toEqual([{ bin: "gcloud", args: ["auth", "application-default", "login"] }]);
    } finally {
      cleanup();
    }
  });

  it("resolves a Gemini Developer API key as an api-key credential", async () => {
    const { secrets, cleanup } = tempSecretStore({ GEMINI_API_KEY: "AIza-dev-key" });
    try {
      const exec = fakeExec({ bins: new Set() });
      const strat = createGoogleAuthStrategy({
        providerId: "gemini",
        secrets,
        apiKeyEnv: "GEMINI_API_KEY",
        exec,
        env: { GEMINI_API_KEY: "AIza-dev-key" },
      });
      const status = await strat.status();
      expect(status.loggedIn).toBe(true);
      const cred = await strat.resolveCredential();
      expect(cred.kind).toBe("api-key");
      expect(cred.value).toBe("AIza-dev-key");
    } finally {
      cleanup();
    }
  });

  it("degrades to 'none' when a stale, unrefreshable OAuth token would throw", async () => {
    // No api key, no gcloud/ADC, and a stored OAuth token that is expired with
    // no refresh token → getFresh throws invalid_grant. resolveCredential must
    // swallow that and return "none" (the SDK's own chain then applies), not
    // propagate the throw. Regression for the latent google.ts bug.
    const { secrets, cleanup } = tempSecretStore();
    try {
      await secrets.set(
        "oauth:gemini",
        JSON.stringify({
          accessToken: "access-stale",
          expiresAt: Date.now() - 60_000,
          scope: "https://www.googleapis.com/auth/cloud-platform",
          tokenType: "Bearer",
          // no refreshToken → getFresh throws.
        }),
      );
      const exec = fakeExec({ bins: new Set() });
      const strat = createGoogleAuthStrategy({ providerId: "gemini", secrets, exec, env: {} });
      const cred = await strat.resolveCredential();
      expect(cred.kind).toBe("none");
      expect(cred.value).toBe("");
    } finally {
      cleanup();
    }
  });
});

// ── ProviderAuthRegistry ─────────────────────────────────────────────────────

describe("ProviderAuthRegistry", () => {
  it("wires an honest default strategy per provider with the right kinds", async () => {
    const { secrets, cleanup } = tempSecretStore();
    try {
      const exec = fakeExec({ bins: new Set(), files: new Set() });
      const reg = createDefaultAuthRegistry({ secrets, exec, env: {}, fetchImpl: fetch });

      expect(reg.get("anthropic")?.kind).toBe("oauth");
      expect(reg.get("openai")?.kind).toBe("api-key");
      expect(reg.get("groq")?.kind).toBe("api-key");
      expect(reg.get("claude-code")?.kind).toBe("cli-delegate");
      expect(reg.get("codex")?.kind).toBe("cli-delegate");
      expect(reg.get("gemini-cli")?.kind).toBe("cli-delegate");
      expect(reg.get("bedrock")?.kind).toBe("cloud-sso");
      expect(reg.get("gemini")).toBeTruthy();
      expect(reg.get("vertex")).toBeTruthy();

      // statusAll reports a login state for every registered provider (offline).
      const statuses = await reg.statusAll();
      expect(statuses.length).toBe(reg.ids().length);
      for (const s of statuses) {
        expect(typeof s.loggedIn).toBe("boolean");
        expect(s.method.length).toBeGreaterThan(0);
      }
    } finally {
      cleanup();
    }
  });

  it("a manually-registered strategy can be looked up and overwritten", () => {
    const reg = new ProviderAuthRegistry();
    expect(reg.has("x")).toBe(false);
    const s = createApiKeyStrategy({ providerId: "x", secrets: tempSecretStore().secrets });
    reg.register(s);
    expect(reg.has("x")).toBe(true);
    expect(reg.get("x")).toBe(s);
  });
});
