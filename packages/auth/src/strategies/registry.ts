/**
 * `ProviderAuthRegistry` — maps a provider id to its {@link AuthStrategy}, and
 * {@link createDefaultAuthRegistry} wires the honest default strategy for every
 * built-in provider. This is the seam the runtime/CLI use so `nexus login
 * <provider>` runs the RIGHT flow and `resolveCredential` hands the right
 * token/key to each adapter.
 *
 * Default wiring (each REAL, none faked):
 *   anthropic     → composite OAuth ("Claude account") + api-key alternative
 *   openai        → api-key (the OpenAI API authenticates by key — honest)
 *   compat family → api-key (groq/together/deepseek/mistral/openrouter/nvidia/azure)
 *   gemini/vertex → Google composite (gcloud ADC delegate / OAuth / api-key)
 *   claude-code   → cli-delegate to `claude` login
 *   codex         → cli-delegate to `codex` login
 *   gemini-cli    → cli-delegate to `gemini` login
 *   bedrock       → cloud-sso (`aws sso login`; AWS credential chain)
 */

import type { SecretStore } from "@nexuscode/config";
import type { FetchLike } from "../types.js";
import type { AuthStatus, AuthStrategy } from "./types.js";
import { createAnthropicAuthStrategy } from "./anthropic.js";
import { createGoogleAuthStrategy } from "./google.js";
import { createApiKeyStrategy } from "./api-key.js";
import { createCliDelegateStrategy } from "./cli-delegate.js";
import { createCloudSsoStrategy, awsCredsPresent } from "./cloud-sso.js";
import { defaultExec, type StrategyExec } from "./exec.js";
import { OPENAI_API_KEY_ENV, OPENAI_KEY_PAGE_URL } from "./providers.js";

/** A mutable registry of provider id → {@link AuthStrategy}. */
export class ProviderAuthRegistry {
  private readonly strategies = new Map<string, AuthStrategy>();

  /** Register (overwrite) the strategy for `strategy.providerId`. */
  register(strategy: AuthStrategy): void {
    this.strategies.set(strategy.providerId, strategy);
  }

  has(providerId: string): boolean {
    return this.strategies.has(providerId);
  }

  get(providerId: string): AuthStrategy | undefined {
    return this.strategies.get(providerId);
  }

  ids(): string[] {
    return [...this.strategies.keys()];
  }

  list(): AuthStrategy[] {
    return [...this.strategies.values()];
  }

  /** Snapshot the login state of every registered provider (no prompting). */
  async statusAll(): Promise<AuthStatus[]> {
    return Promise.all(this.list().map((s) => s.status()));
  }
}

/** The OpenAI-compat + Azure providers that authenticate by API key. */
const API_KEY_PROVIDERS: ReadonlyArray<{ id: string; keyEnv?: string; keyPageUrl?: string }> = [
  { id: "groq", keyEnv: "GROQ_API_KEY", keyPageUrl: "https://console.groq.com/keys" },
  { id: "together", keyEnv: "TOGETHER_API_KEY", keyPageUrl: "https://api.together.ai/settings/api-keys" },
  { id: "deepseek", keyEnv: "DEEPSEEK_API_KEY", keyPageUrl: "https://platform.deepseek.com/api_keys" },
  { id: "mistral", keyEnv: "MISTRAL_API_KEY", keyPageUrl: "https://console.mistral.ai/api-keys" },
  { id: "openrouter", keyEnv: "OPENROUTER_API_KEY", keyPageUrl: "https://openrouter.ai/keys" },
  { id: "nvidia", keyEnv: "NVIDIA_API_KEY" },
  { id: "azure-openai", keyEnv: "AZURE_OPENAI_API_KEY" },
];

/** The wrapped vendor coding CLIs, each delegating to its own login. */
const CLI_DELEGATES: ReadonlyArray<{
  providerId: string;
  bin: string;
  label: string;
  loginArgs: string[];
  logoutArgs?: string[];
  sessionFiles: string[];
}> = [
  {
    providerId: "claude-code",
    bin: "claude",
    label: "Claude Code",
    loginArgs: ["/login"],
    logoutArgs: ["/logout"],
    // Claude Code stores its OAuth credentials under $HOME on login.
    sessionFiles: [".claude/.credentials.json", ".claude.json", ".config/claude/.credentials.json"],
  },
  {
    providerId: "codex",
    bin: "codex",
    label: "Codex CLI",
    loginArgs: ["login"],
    logoutArgs: ["logout"],
    sessionFiles: [".codex/auth.json", ".config/codex/auth.json"],
  },
  {
    providerId: "gemini-cli",
    bin: "gemini",
    label: "Gemini CLI",
    loginArgs: ["auth", "login"],
    sessionFiles: [".gemini/oauth_creds.json", ".config/gemini/oauth_creds.json"],
  },
];

export interface DefaultAuthRegistryOptions {
  secrets: SecretStore;
  /** Injected fetch for OAuth flows/refresh (tests → mock AS). */
  fetchImpl?: FetchLike;
  now?: () => number;
  /** Best-effort browser opener passed to guided api-key + OAuth logins. */
  openBrowser?: (url: string) => Promise<boolean> | boolean;
  /** Injectable exec/fs seam for cli-delegate + cloud-sso (default real). */
  exec?: StrategyExec;
  env?: NodeJS.ProcessEnv;
}

/** Build a registry wired with the honest default strategy per provider. */
export function createDefaultAuthRegistry(opts: DefaultAuthRegistryOptions): ProviderAuthRegistry {
  const reg = new ProviderAuthRegistry();
  const exec = opts.exec ?? defaultExec();
  const env = opts.env ?? process.env;

  // Anthropic — OAuth ("login like Claude Code") + api-key alternative.
  reg.register(
    createAnthropicAuthStrategy({
      secrets: opts.secrets,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.openBrowser ? { openBrowser: opts.openBrowser } : {}),
      env,
    }),
  );

  // OpenAI — honest api-key (the OpenAI API authenticates by key, not OAuth).
  reg.register(
    createApiKeyStrategy({
      providerId: "openai",
      secrets: opts.secrets,
      keyEnv: OPENAI_API_KEY_ENV,
      keyPageUrl: OPENAI_KEY_PAGE_URL,
      label: "api-key",
      ...(opts.openBrowser ? { openBrowser: opts.openBrowser } : {}),
      env,
    }),
  );

  // OpenAI-compat family + Azure — api-key.
  for (const p of API_KEY_PROVIDERS) {
    reg.register(
      createApiKeyStrategy({
        providerId: p.id,
        secrets: opts.secrets,
        ...(p.keyEnv ? { keyEnv: p.keyEnv } : {}),
        ...(p.keyPageUrl ? { keyPageUrl: p.keyPageUrl } : {}),
        label: "api-key",
        ...(opts.openBrowser ? { openBrowser: opts.openBrowser } : {}),
        env,
      }),
    );
  }

  // Gemini + Vertex — Google composite (gcloud ADC / OAuth / api-key).
  for (const id of ["gemini", "vertex"]) {
    reg.register(
      createGoogleAuthStrategy({
        providerId: id,
        secrets: opts.secrets,
        apiKeyRef: "gemini",
        ...(id === "gemini" ? { apiKeyEnv: "GEMINI_API_KEY" } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.now ? { now: opts.now } : {}),
        ...(opts.openBrowser ? { openBrowser: opts.openBrowser } : {}),
        exec,
        env,
      }),
    );
  }

  // Wrapped coding CLIs — cli-delegate to the vendor's own login.
  for (const spec of CLI_DELEGATES) {
    reg.register(
      createCliDelegateStrategy({
        spec: {
          providerId: spec.providerId,
          bin: spec.bin,
          label: spec.label,
          loginArgs: spec.loginArgs,
          ...(spec.logoutArgs ? { logoutArgs: spec.logoutArgs } : {}),
          sessionFiles: spec.sessionFiles,
        },
        exec,
      }),
    );
  }

  // Bedrock — cloud-sso (AWS credential chain; `aws sso login`).
  reg.register(
    createCloudSsoStrategy({
      spec: {
        providerId: "bedrock",
        bin: "aws",
        label: "AWS SSO",
        loginArgs: ["sso", "login"],
        credsPresent: (e) => awsCredsPresent(e, env),
      },
      exec,
    }),
  );

  return reg;
}
