/**
 * `@nexuscode/runtime` — the runtime assembly: turn a loaded, validated config
 * into a live `ProviderRegistry`, a `SecretStore`, and a `PricingTable`. Core
 * never imports a concrete adapter — this is the one place that maps a config
 * `kind` to an implementation. The built-in `mock` provider is always available
 * (offline, no keys); every other provider is dynamically `import()`ed so a
 * broken or unpublished provider package can never take down the host process.
 *
 * This is the ONE shared bootstrap every harness client reuses (the CLI, the
 * embeddable SDK, the REST daemon, …) so the "engine is the single source of
 * truth" invariant holds: no client re-implements provider assembly.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { configureHttpPool } from "@nexuscode/shared";
import { ProviderRegistry, type ProviderAdapter } from "@nexuscode/core";
import {
  createSecretStore,
  pricingTable,
  type NexusConfig,
  type ProviderConfig,
  type SecretStore,
} from "@nexuscode/config";
import {
  createMockAdapter,
  createFlakyMockAdapter,
  createSlowMockAdapter,
} from "@nexuscode/provider-mock";
import {
  applyGateway,
  resolveGateway,
  type GatewaySet,
  type GatewayableProviderConfig,
} from "@nexuscode/enterprise";
import { LazySubsystems } from "./lazy.js";

export { lazy, lazyAsync, LazySubsystems } from "./lazy.js";
export type { Lazy, LazyAsync } from "./lazy.js";

export interface ProviderStatus {
  id: string;
  kind: string;
  available: boolean;
  detail?: string;
  /** True when the provider is registered but has no resolvable credential yet. */
  needsKey?: boolean;
}

/**
 * A resolved credential + how the adapter must send it. Mirrors
 * `@nexuscode/auth`'s `ResolvedCredential`; duck-typed here so the runtime does
 * not build-couple to the auth package. `"bearer"` → `Authorization: Bearer`
 * (an auto-refreshed OAuth token); `"api-key"` → the provider's key header;
 * `"none"` → the adapter/SDK resolves credentials itself.
 */
export interface RuntimeResolvedCredential {
  kind: "bearer" | "api-key" | "none";
  value: string;
}

/**
 * The minimal, duck-typed view of `@nexuscode/auth`'s `ProviderAuthRegistry`
 * the runtime needs to wire per-provider credentials into adapters. Passing one
 * to {@link buildRuntime} lets an OAuth-backed provider (Anthropic "login like
 * Claude Code") send an auto-refreshed Bearer token instead of an API key. Omit
 * it to keep the legacy api-key resolution unchanged.
 */
export interface AuthRegistryLike {
  get(providerId: string):
    | { resolveCredential(): Promise<RuntimeResolvedCredential> }
    | undefined;
}

/**
 * The always-present default providers beyond `mock`, so `providers list` /
 * `doctor` / routing can see the full catalog with zero config. The OpenAI-compat
 * and Azure entries register **offline** (no health probe, no network): their
 * reachability is reported as "needs key" when no credential is resolvable rather
 * than as a health failure. The `mock-flaky` / `mock-slow` entries are fully
 * offline and health-checked (they back the failover / latency demos + tests).
 */
interface DefaultCompatSpec {
  id: string;
  /** Env var read for the credential. Omitted ⇒ local, auth-less backend. */
  keyEnv?: string;
}

const DEFAULT_COMPAT_PROVIDERS: readonly DefaultCompatSpec[] = [
  { id: "groq", keyEnv: "GROQ_API_KEY" },
  { id: "together", keyEnv: "TOGETHER_API_KEY" },
  { id: "deepseek", keyEnv: "DEEPSEEK_API_KEY" },
  { id: "mistral", keyEnv: "MISTRAL_API_KEY" },
  { id: "openrouter", keyEnv: "OPENROUTER_API_KEY" },
  { id: "nvidia", keyEnv: "NVIDIA_API_KEY" },
  { id: "lmstudio" },
  { id: "vllm" },
];

const AZURE_KEY_ENV = "AZURE_OPENAI_API_KEY";

/**
 * The always-present subprocess coding-CLI providers (master-plan §4.8). Each
 * wraps a local coding CLI as a first-class `ProviderAdapter`; health is simply
 * "is the binary on PATH" (never a network call), and an absent binary degrades
 * to `available:false` with a "not installed" detail — never a crash. The `bin`
 * is overridable via env so an offline integration test can point at a
 * deterministic fake CLI.
 */
interface SubprocessSpec {
  id: string;
  /** Provider package dynamically imported so a missing pkg degrades gracefully. */
  pkg: string;
  /** Factory export name in the package. */
  factory: string;
  /** Default CLI binary name. */
  defaultBin: string;
  /** Env var overriding the binary path (for tests / custom installs). */
  binEnv: string;
}

const SUBPROCESS_PROVIDERS: readonly SubprocessSpec[] = [
  { id: "claude-code", pkg: "@nexuscode/provider-claude-code", factory: "createClaudeCodeAdapter", defaultBin: "claude", binEnv: "NEXUS_CLAUDE_CODE_BIN" },
  { id: "codex", pkg: "@nexuscode/provider-codex", factory: "createCodexAdapter", defaultBin: "codex", binEnv: "NEXUS_CODEX_BIN" },
];

/**
 * The always-present native cloud-model providers (system-spec §2: Gemini,
 * Bedrock, Vertex). Each wraps an official SDK behind the frozen ProviderAdapter
 * contract. Registration is fully offline (no `capabilities()`/`health` network
 * call — capabilities are static, and the health probe is skipped): the provider
 * is registered so routing/`providers list`/`doctor` see it, and its reported
 * status reflects only whether a credential / creds are resolvable. A missing or
 * broken provider package degrades to an unavailable status — never a crash.
 */
interface NativeSpec {
  id: string;
  kind: "gemini" | "bedrock" | "vertex";
  /** Provider package dynamically imported so a missing pkg degrades gracefully. */
  pkg: string;
  /** Factory export name in the package. */
  factory: string;
  /** Build the factory config from the loaded NexusConfig. */
  buildConfig: (config: NexusConfig) => Record<string, unknown>;
  /** Whether the provider is enabled in config. */
  enabled: (config: NexusConfig) => boolean;
  /** Offline credential/creds probe (env + credential files only; never network). */
  hasCreds: (config: NexusConfig, secrets: SecretStore) => Promise<boolean>;
  /** Detail line when credentials are present. */
  readyDetail: (config: NexusConfig) => string;
  /** Detail line when credentials are missing (shown as "needs key/creds"). */
  needsDetail: (config: NexusConfig) => string;
}

/** True when the standard AWS credential chain can plausibly resolve — env or files only. */
function awsCredsPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return true;
  if (env.AWS_PROFILE) return true;
  if (env.AWS_ROLE_ARN && env.AWS_WEB_IDENTITY_TOKEN_FILE) return true;
  if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI) return true;
  const home = env.HOME ?? env.USERPROFILE;
  if (home && (existsSync(join(home, ".aws", "credentials")) || existsSync(join(home, ".aws", "config")))) {
    return true;
  }
  return false;
}

/** True when Google Cloud Application Default Credentials can plausibly resolve — env or files only. */
function gcpAdcPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  const gac = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac && existsSync(gac)) return true;
  const home = env.HOME ?? env.USERPROFILE;
  if (home) {
    const adc = join(home, ".config", "gcloud", "application_default_credentials.json");
    if (existsSync(adc)) return true;
  }
  const appData = env.APPDATA;
  if (appData && existsSync(join(appData, "gcloud", "application_default_credentials.json"))) return true;
  return false;
}

const NATIVE_PROVIDERS: readonly NativeSpec[] = [
  {
    id: "gemini",
    kind: "gemini",
    pkg: "@nexuscode/provider-gemini",
    factory: "createGeminiAdapter",
    buildConfig: (c) => ({ modelMap: c.gemini.modelMap }),
    enabled: (c) => c.gemini.enabled,
    hasCreds: async (c, secrets) => {
      const fromEnv = process.env[c.gemini.apiKeyEnv] ?? process.env.GOOGLE_API_KEY;
      if (fromEnv && fromEnv.length > 0) return true;
      const stored = await secrets.get("gemini");
      return !!stored && stored.length > 0;
    },
    readyDetail: (c) => `key present (${c.gemini.apiKeyEnv})`,
    needsDetail: (c) => `needs key: ${c.gemini.apiKeyEnv}`,
  },
  {
    id: "bedrock",
    kind: "bedrock",
    pkg: "@nexuscode/provider-bedrock",
    factory: "createBedrockAdapter",
    buildConfig: (c) => (c.bedrock.region ? { modelMap: c.bedrock.modelMap, region: c.bedrock.region } : { modelMap: c.bedrock.modelMap }),
    enabled: (c) => c.bedrock.enabled,
    hasCreds: async () => awsCredsPresent(),
    readyDetail: () => "AWS credentials present (credential chain)",
    needsDetail: () => "needs creds: AWS credential chain (AWS_ACCESS_KEY_ID / AWS_PROFILE / ~/.aws)",
  },
  {
    id: "vertex",
    kind: "vertex",
    pkg: "@nexuscode/provider-vertex",
    factory: "createVertexAdapter",
    buildConfig: (c) => {
      const cfg: Record<string, unknown> = { modelMap: c.vertex.modelMap, location: c.vertex.location };
      if (c.vertex.project) cfg.project = c.vertex.project;
      return cfg;
    },
    enabled: (c) => c.vertex.enabled,
    hasCreds: async () => gcpAdcPresent(),
    readyDetail: () => "GCP ADC present",
    needsDetail: () => "needs creds: GCP ADC (GOOGLE_APPLICATION_CREDENTIALS / gcloud auth application-default login)",
  },
];

/**
 * Is `bin` runnable? An absolute/relative path is checked directly; a bare name
 * is searched across `PATH`. Fully offline and synchronous — no spawn. On
 * Windows the usual executable extensions are also probed.
 */
export function binaryOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  if (bin.includes("/") || bin.includes("\\")) {
    return exts.some((e) => existsSync(bin + e));
  }
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    for (const e of exts) {
      if (existsSync(join(dir, bin + e))) return true;
    }
  }
  return false;
}

export interface Runtime {
  registry: ProviderRegistry;
  secrets: SecretStore;
  pricing: ReturnType<typeof pricingTable>;
  /** Registration outcome per provider (for `doctor` / `providers list`). */
  statuses: ProviderStatus[];
  /**
   * Lazily-constructed heavy subsystems (RAG index, LSP servers, `tools-*`
   * groups, the REST server). Nothing here is built during bootstrap — each is
   * constructed on first `get()` (system-spec §23: lazy loading), so startup and
   * one-shot `ask` stay fast. Empty unless the caller injected `subsystems`.
   */
  subsystems: LazySubsystems;
}

/** An untyped adapter-factory pulled from a dynamically imported provider pkg. */
type AdapterFactory = (...args: unknown[]) => ProviderAdapter;

/**
 * A lazy credential resolver for one provider. It reads the explicit
 * `apiKeyEnv` first, then falls through the SecretStore chain
 * (env → keychain → encrypted file) keyed by `apiKeyRef` (or the provider id).
 * Returns `""` when nothing is set — the adapter surfaces that as an `auth`
 * failure only when actually used, so registration/`doctor` never block on it.
 * The key value is never logged.
 */
function credentialFor(pc: ProviderConfig, secrets: SecretStore): () => Promise<string> {
  return async (): Promise<string> => {
    if (pc.apiKeyEnv) {
      const fromEnv = process.env[pc.apiKeyEnv];
      if (fromEnv && fromEnv.length > 0) return fromEnv;
    }
    const ref = pc.apiKeyRef ?? pc.id;
    const resolved = await secrets.get(ref);
    return resolved ?? "";
  };
}

/**
 * Map one config `kind` to a concrete adapter. This is the only place that
 * knows provider package APIs. Everything but `mock` is loaded through a
 * *variable* dynamic `import()` so the CLI never build-couples to a provider's
 * types and a missing/broken provider package degrades to an unavailable status
 * instead of taking down the process.
 */
async function loadConfiguredAdapter(
  pc: ProviderConfig,
  secrets: SecretStore,
  gatewayHeaders?: Record<string, string>,
  authRegistry?: AuthRegistryLike,
): Promise<{ adapter?: ProviderAdapter; detail?: string }> {
  if (pc.kind === "mock") {
    return { adapter: createMockAdapter({ id: pc.id }) };
  }
  if (pc.kind === "subprocess") {
    return { detail: `kind "subprocess" is provided via the default catalog (claude-code / codex)` };
  }
  if (pc.kind === "gemini" || pc.kind === "bedrock" || pc.kind === "vertex") {
    return loadNativeAdapter(pc, secrets);
  }

  const cred = credentialFor(pc, secrets);
  // `spec` is a variable, so tsc treats `import(spec)` as `Promise<any>` and
  // does not resolve (or build-couple to) the provider package's declarations.
  const spec =
    pc.kind === "anthropic" ? "@nexuscode/provider-anthropic" : "@nexuscode/provider-openai";

  let mod: Record<string, unknown>;
  try {
    mod = (await import(spec)) as Record<string, unknown>;
  } catch (e) {
    return { detail: `provider package "${spec}" not loadable: ${(e as Error).message}` };
  }

  try {
    if (pc.kind === "anthropic") {
      const factory = mod["createAnthropicAdapter"];
      if (typeof factory !== "function") {
        return { detail: `"${spec}" has no createAnthropicAdapter() export` };
      }
      const cfg: Record<string, unknown> = { modelMap: pc.modelMap };
      if (pc.baseUrl) cfg.baseURL = pc.baseUrl;
      // Private-gateway (§25): inject the gateway's signed org token / x-org-id
      // headers so an auth-requiring gateway does not reject the traffic.
      if (gatewayHeaders && Object.keys(gatewayHeaders).length > 0) cfg.defaultHeaders = gatewayHeaders;
      // OAuth "login like Claude Code": when an auth registry supplies an
      // Anthropic strategy, wire its credential source so the adapter sends the
      // auto-refreshed OAuth Bearer token (falling back to an API key when only
      // a console key is stored). Absent a registry, the legacy api-key `cred`
      // resolver is used unchanged.
      const anthropicStrategy = authRegistry?.get(pc.id);
      if (anthropicStrategy) {
        cfg.credential = () => anthropicStrategy.resolveCredential();
      }
      return { adapter: (factory as AdapterFactory)(cfg, cred) };
    }

    // kind === "openai-compat": OpenAI, Grok, Ollama, Groq, DeepSeek, … all
    // ride the one OpenAI-compatible transport; only the baseURL/pricing differ.
    const factory = mod["createOpenAICompatAdapter"];
    if (typeof factory !== "function") {
      return { detail: `"${spec}" has no createOpenAICompatAdapter() export` };
    }
    const isLocal = pc.id === "ollama" || (pc.baseUrl?.includes("11434") ?? false);
    const cfg: Record<string, unknown> = {
      id: pc.id,
      modelMap: pc.modelMap,
      models: pc.models.map((id) => ({ id })),
      apiKey: cred,
      requiresAuth: !isLocal,
      zeroCost: isLocal,
    };
    if (pc.baseUrl) cfg.baseURL = pc.baseUrl;
    // Private-gateway (§25): thread the merged gateway headers to the transport.
    if (gatewayHeaders && Object.keys(gatewayHeaders).length > 0) cfg.defaultHeaders = gatewayHeaders;
    return { adapter: (factory as AdapterFactory)(cfg) };
  } catch (e) {
    return { detail: `adapter construction failed: ${(e as Error).message}` };
  }
}

/**
 * Build a native cloud-model adapter (gemini / bedrock / vertex) from a
 * user-configured `providers[]` entry. Loaded through a variable dynamic
 * `import()` so the CLI never build-couples to the provider package and a
 * missing/broken package degrades to an unavailable status. Construction is
 * offline (lazy SDK client); region/project/location come from the entry's
 * `flags` or the process env.
 */
async function loadNativeAdapter(
  pc: ProviderConfig,
  secrets: SecretStore,
): Promise<{ adapter?: ProviderAdapter; detail?: string }> {
  const spec =
    pc.kind === "gemini"
      ? { pkg: "@nexuscode/provider-gemini", factory: "createGeminiAdapter" }
      : pc.kind === "bedrock"
        ? { pkg: "@nexuscode/provider-bedrock", factory: "createBedrockAdapter" }
        : { pkg: "@nexuscode/provider-vertex", factory: "createVertexAdapter" };

  let mod: Record<string, unknown>;
  try {
    mod = (await import(spec.pkg)) as Record<string, unknown>;
  } catch (e) {
    return { detail: `provider package "${spec.pkg}" not loadable: ${(e as Error).message}` };
  }
  const factory = mod[spec.factory];
  if (typeof factory !== "function") {
    return { detail: `"${spec.pkg}" has no ${spec.factory}() export` };
  }

  try {
    const cfg: Record<string, unknown> = { modelMap: pc.modelMap };
    if (pc.kind === "bedrock") {
      const region = pc.flags?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
      if (region) cfg.region = region;
      return { adapter: (factory as AdapterFactory)(cfg) };
    }
    if (pc.kind === "vertex") {
      const project = pc.flags?.project ?? process.env.GOOGLE_CLOUD_PROJECT;
      const location = pc.flags?.location ?? process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
      if (project) cfg.project = project;
      cfg.location = location;
      return { adapter: (factory as AdapterFactory)(cfg) };
    }
    // gemini: an optional lazy API-key resolver (env → SecretStore).
    const cred = credentialFor(pc, secrets);
    return { adapter: (factory as AdapterFactory)(cfg, cred) };
  } catch (e) {
    return { detail: `adapter construction failed: ${(e as Error).message}` };
  }
}

/** Is a credential resolvable for `keyEnv` (env first, then the SecretStore under `id`)? */
async function hasCredential(
  keyEnv: string | undefined,
  id: string,
  secrets: SecretStore,
): Promise<boolean> {
  if (keyEnv) {
    const fromEnv = process.env[keyEnv];
    if (fromEnv && fromEnv.length > 0) return true;
  }
  const stored = await secrets.get(id);
  return !!stored && stored.length > 0;
}

/**
 * Register the always-present default OpenAI-compatible + Azure providers,
 * fully offline: no health probe, no network. Each is loaded through a dynamic
 * `import()` so a missing/broken provider package degrades to an unavailable
 * status instead of taking down the CLI. Reachability is reported as "needs key"
 * when no credential is resolvable.
 */
async function registerDefaultCloudProviders(
  registry: ProviderRegistry,
  secrets: SecretStore,
  statuses: ProviderStatus[],
): Promise<void> {
  // OpenAI-compat family (groq/together/deepseek/mistral/openrouter/nvidia/lmstudio/vllm).
  // `spec` is typed `string`, so tsc treats `import(spec)` as `Promise<any>` and does not
  // resolve (or build-couple to) the provider package's declarations.
  const openaiSpec: string = "@nexuscode/provider-openai";
  let openaiMod: Record<string, unknown> | undefined;
  try {
    openaiMod = (await import(openaiSpec)) as Record<string, unknown>;
  } catch {
    openaiMod = undefined;
  }
  const createCompatAdapter = openaiMod?.["createCompatAdapter"] as
    | ((id: string) => ProviderAdapter)
    | undefined;

  if (createCompatAdapter) {
    for (const spec of DEFAULT_COMPAT_PROVIDERS) {
      if (registry.has(spec.id)) continue;
      let adapter: ProviderAdapter;
      try {
        adapter = createCompatAdapter(spec.id);
      } catch (e) {
        statuses.push({ id: spec.id, kind: "openai-compat", available: false, detail: (e as Error).message });
        continue;
      }
      const keyed = await hasCredential(spec.keyEnv, spec.id, secrets);
      const detail = spec.keyEnv
        ? keyed
          ? `key present (${spec.keyEnv})`
          : `needs key: ${spec.keyEnv}`
        : "local — no key needed (start the server to use)";
      try {
        await registry.register(adapter, { skipHealth: true });
        statuses.push({ id: spec.id, kind: "openai-compat", available: true, detail, needsKey: !!spec.keyEnv && !keyed });
      } catch (e) {
        statuses.push({ id: spec.id, kind: "openai-compat", available: false, detail: (e as Error).message });
      }
    }
  }

  // Azure OpenAI. Endpoint/deployment come from env when present; placeholders
  // otherwise (construction is network-free; a real call without a key fails fast).
  if (!registry.has("azure-openai")) {
    // Typed `string` so tsc does not build-couple runtime to the provider's declarations.
    const azureSpec: string = "@nexuscode/provider-azure";
    let azureMod: Record<string, unknown> | undefined;
    try {
      azureMod = (await import(azureSpec)) as Record<string, unknown>;
    } catch {
      azureMod = undefined;
    }
    const createAzure = azureMod?.["createAzureOpenAIAdapter"] as
      | ((opts: {
          endpoint: string;
          apiVersion: string;
          deployment: string;
        }) => ProviderAdapter)
      | undefined;
    if (createAzure) {
      try {
        const adapter = createAzure({
          endpoint: process.env["AZURE_OPENAI_ENDPOINT"] ?? "https://<resource>.openai.azure.com",
          apiVersion: process.env["AZURE_OPENAI_API_VERSION"] ?? "2024-10-21",
          deployment: process.env["AZURE_OPENAI_DEPLOYMENT"] ?? "gpt-4o",
        });
        const keyed = await hasCredential(AZURE_KEY_ENV, "azure-openai", secrets);
        const detail = keyed ? `key present (${AZURE_KEY_ENV})` : `needs key: ${AZURE_KEY_ENV} + endpoint`;
        await registry.register(adapter, { skipHealth: true });
        statuses.push({ id: "azure-openai", kind: "azure", available: true, detail, needsKey: !keyed });
      } catch (e) {
        statuses.push({ id: "azure-openai", kind: "azure", available: false, detail: (e as Error).message });
      }
    }
  }
}

/** The env var checked (before the SecretStore) for a console Anthropic API key. */
const ANTHROPIC_KEY_ENV = "ANTHROPIC_API_KEY";

/**
 * Register a default "anthropic" adapter driven by the caller's
 * {@link AuthRegistryLike} — the missing half of the OAuth "login like Claude
 * Code" story. `loadConfiguredAdapter` above already wires an auth registry's
 * resolved credential into the adapter, but that wiring only ever runs for a
 * user-added `providers: [{ id: "anthropic", ... }]` entry. `providers[]`
 * defaults to EMPTY (schema default), and `nexus login anthropic` only writes
 * a token through the auth registry's SecretStore — it never adds a config
 * entry. So on a fresh install, "anthropic" was never registered at all:
 * `isProviderUsable` returned false before it ever got to look at a credential,
 * and the DEFAULT run path (bare `nexus`) dead-ended into the offline mock
 * provider despite a successful `nexus login anthropic`.
 *
 * Skipped entirely when the caller passed no `authRegistry` (preserves the
 * exact pre-existing behavior for every caller that does not opt into
 * auth-aware credential resolution) or when the user already has an explicit
 * `anthropic` entry in `providers[]` (that entry — and its own credential
 * wiring — wins, unchanged). `needsKey` reflects whichever credential is
 * ACTUALLY resolvable right now: a stored OAuth token (bearer), a console API
 * key (env or SecretStore), or neither — so a merely-registered-but-signed-out
 * anthropic still correctly falls back to mock.
 */
async function registerDefaultAnthropicProvider(
  registry: ProviderRegistry,
  secrets: SecretStore,
  statuses: ProviderStatus[],
  authRegistry: AuthRegistryLike,
  signal?: AbortSignal,
): Promise<void> {
  if (registry.has("anthropic")) return;
  const strategy = authRegistry.get("anthropic");
  if (!strategy) return;

  // Typed `string` so tsc does not build-couple runtime to the provider's declarations.
  const anthropicSpec: string = "@nexuscode/provider-anthropic";
  let mod: Record<string, unknown>;
  try {
    mod = (await import(anthropicSpec)) as Record<string, unknown>;
  } catch (e) {
    statuses.push({
      id: "anthropic",
      kind: "anthropic",
      available: false,
      detail: `provider package "${anthropicSpec}" not loadable: ${(e as Error).message}`,
    });
    return;
  }
  const factory = mod["createAnthropicAdapter"] as AdapterFactory | undefined;
  if (typeof factory !== "function") {
    statuses.push({
      id: "anthropic",
      kind: "anthropic",
      available: false,
      detail: `"@nexuscode/provider-anthropic" has no createAnthropicAdapter() export`,
    });
    return;
  }

  // A curated identity model map (native ids only) so `firstModel()` has a
  // sensible pick with no explicit `-m`/`defaultModel` — the SAME curated
  // catalog the adapter itself falls back to for `listModels()`.
  const defaultModels = (mod["DEFAULT_ANTHROPIC_MODELS"] as Array<{ id: string }> | undefined) ?? [];
  const modelMap = Object.fromEntries(defaultModels.map((m) => [m.id, m.id]));

  // A credential is usable when EITHER the plain key path (env/SecretStore)
  // OR the auth registry's strategy (an OAuth bearer, or its own api-key
  // fallback) actually resolves to something non-empty.
  let keyed = await hasCredential(ANTHROPIC_KEY_ENV, "anthropic", secrets);
  if (!keyed) {
    try {
      const resolved = await strategy.resolveCredential();
      keyed = resolved.kind !== "none" && resolved.value.length > 0;
    } catch {
      keyed = false;
    }
  }
  const detail = keyed
    ? "signed in (`nexus login anthropic`) or key present"
    : `needs key: ${ANTHROPIC_KEY_ENV} (or \`nexus login anthropic\`)`;

  try {
    const adapter = (factory as AdapterFactory)(
      { modelMap, credential: () => strategy.resolveCredential() },
      async () => {
        const fromEnv = process.env[ANTHROPIC_KEY_ENV];
        if (fromEnv && fromEnv.length > 0) return fromEnv;
        return (await secrets.get("anthropic")) ?? "";
      },
    );
    await registry.register(adapter, signal ? { signal } : undefined);
    statuses.push({ id: "anthropic", kind: "anthropic", available: true, detail, needsKey: !keyed });
  } catch (e) {
    statuses.push({ id: "anthropic", kind: "anthropic", available: false, detail: (e as Error).message });
  }
}

/**
 * Register the always-present subprocess coding-CLI providers (claude-code,
 * codex). The adapter is registered unconditionally (so `nexus code` / `agent
 * --provider claude-code` can dispatch through the SAME engine path and surface
 * a clean transport error if the CLI is truly absent), while the reported status
 * reflects whether the binary is on PATH — an absent binary shows "not installed"
 * and never fails. Registration is fully offline: no `--version` spawn, no
 * network. A missing/broken provider package degrades to an unavailable status.
 */
async function registerSubprocessProviders(
  registry: ProviderRegistry,
  statuses: ProviderStatus[],
): Promise<void> {
  for (const spec of SUBPROCESS_PROVIDERS) {
    if (registry.has(spec.id)) continue;
    let mod: Record<string, unknown>;
    try {
      mod = (await import(spec.pkg)) as Record<string, unknown>;
    } catch (e) {
      statuses.push({ id: spec.id, kind: "subprocess", available: false, detail: `provider package not loadable: ${(e as Error).message}` });
      continue;
    }
    const factory = mod[spec.factory];
    if (typeof factory !== "function") {
      statuses.push({ id: spec.id, kind: "subprocess", available: false, detail: `"${spec.pkg}" has no ${spec.factory}() export` });
      continue;
    }
    const bin = process.env[spec.binEnv] ?? spec.defaultBin;
    let adapter: ProviderAdapter;
    try {
      adapter = (factory as AdapterFactory)({ bin });
    } catch (e) {
      statuses.push({ id: spec.id, kind: "subprocess", available: false, detail: (e as Error).message });
      continue;
    }
    const installed = binaryOnPath(bin);
    try {
      await registry.register(adapter, { skipHealth: true });
      statuses.push({
        id: spec.id,
        kind: "subprocess",
        available: installed,
        detail: installed ? `${bin} on PATH` : `not installed (${bin} not on PATH)`,
      });
    } catch (e) {
      statuses.push({ id: spec.id, kind: "subprocess", available: false, detail: (e as Error).message });
    }
  }
}

/**
 * Register the always-present native cloud-model providers (gemini, bedrock,
 * vertex). Fully offline: capabilities are static and the health probe is
 * skipped, so no network is touched. Each is loaded through a dynamic `import()`
 * so a missing/broken provider package degrades to an unavailable status instead
 * of taking down the CLI. Reachability is reported as "needs key/creds" when no
 * credential is resolvable rather than as a health failure — `providers list` /
 * `doctor` stay exit-0 on a fresh, unconfigured machine.
 */
async function registerDefaultNativeProviders(
  registry: ProviderRegistry,
  secrets: SecretStore,
  statuses: ProviderStatus[],
  config: NexusConfig,
): Promise<void> {
  for (const spec of NATIVE_PROVIDERS) {
    if (!spec.enabled(config)) continue;
    if (registry.has(spec.id)) continue;

    let mod: Record<string, unknown>;
    try {
      mod = (await import(spec.pkg)) as Record<string, unknown>;
    } catch (e) {
      statuses.push({ id: spec.id, kind: spec.kind, available: false, detail: `provider package not loadable: ${(e as Error).message}` });
      continue;
    }
    const factory = mod[spec.factory];
    if (typeof factory !== "function") {
      statuses.push({ id: spec.id, kind: spec.kind, available: false, detail: `"${spec.pkg}" has no ${spec.factory}() export` });
      continue;
    }

    let adapter: ProviderAdapter;
    try {
      // gemini takes an optional lazy key resolver; bedrock/vertex read the
      // AWS/GCP credential chain lazily at call time (no key argument).
      adapter =
        spec.kind === "gemini"
          ? (factory as AdapterFactory)(spec.buildConfig(config), async () => {
              const fromEnv = process.env[config.gemini.apiKeyEnv] ?? process.env.GOOGLE_API_KEY;
              if (fromEnv && fromEnv.length > 0) return fromEnv;
              return (await secrets.get("gemini")) ?? "";
            })
          : (factory as AdapterFactory)(spec.buildConfig(config));
    } catch (e) {
      statuses.push({ id: spec.id, kind: spec.kind, available: false, detail: (e as Error).message });
      continue;
    }

    const keyed = await spec.hasCreds(config, secrets);
    const detail = keyed ? spec.readyDetail(config) : spec.needsDetail(config);
    try {
      await registry.register(adapter, { skipHealth: true });
      statuses.push({ id: spec.id, kind: spec.kind, available: true, detail, needsKey: !keyed });
    } catch (e) {
      statuses.push({ id: spec.id, kind: spec.kind, available: false, detail: (e as Error).message });
    }
  }
}

/**
 * Build the runtime. `signal` bounds capability probing. The mock adapter is
 * registered first and unconditionally, so `-p mock` works with zero config.
 * The default cloud providers + the flaky/slow mock variants are then registered
 * so `providers list` / `doctor` / routing see the full catalog with no config.
 */
export async function buildRuntime(
  config: NexusConfig,
  opts: {
    secrets?: SecretStore;
    signal?: AbortSignal;
    gateways?: GatewaySet;
    /**
     * Factories for heavy subsystems, registered lazily (system-spec §23). Each
     * is constructed only on first `runtime.subsystems.get(name)` — never during
     * bootstrap — so assembling the runtime (and `ask`) never spins up the RAG
     * index, an LSP server, a `tools-*` group, or the REST server unless used.
     */
    subsystems?: Record<string, () => unknown>;
    /**
     * Optional per-provider auth registry (`@nexuscode/auth`'s
     * `ProviderAuthRegistry`, duck-typed as {@link AuthRegistryLike}). When
     * present, a provider with an OAuth strategy (Anthropic "login like Claude
     * Code") gets its credential resolved through the registry — an
     * auto-refreshed Bearer token — instead of the legacy api-key path. Omit to
     * preserve the pre-Wave-13 api-key behavior exactly.
     */
    authRegistry?: AuthRegistryLike;
  } = {},
): Promise<Runtime> {
  // Performance (§23): apply the keep-alive HTTP connection-pool tuning process-wide
  // BEFORE any adapter is constructed, so every HTTP provider's shared agent is
  // built from the configured pool size. Idempotent and offline (constructing an
  // Agent opens no socket); the defaults reproduce the pre-Wave-12 pool exactly.
  configureHttpPool({
    maxSockets: config.performance.pool.maxSockets,
    maxFreeSockets: config.performance.pool.maxFreeSockets,
    keepAliveMsecs: config.performance.pool.keepAliveMsecs,
  });

  const registry = new ProviderRegistry();
  const secrets = opts.secrets ?? createSecretStore();
  const statuses: ProviderStatus[] = [];
  // Private model gateway (system-spec §25): when the enterprise subsystem
  // supplies a GatewaySet, rewrite each configured provider's endpoint to the
  // corporate proxy BEFORE the adapter is constructed, so all of that provider's
  // traffic egresses through the gateway. Off by default (empty set ⇒ no-op);
  // fails closed on an off-allowlist gateway host (throws GatewayEgressError).
  const gateways = opts.gateways;

  const register = async (adapter: ProviderAdapter, kind: string): Promise<void> => {
    if (registry.has(adapter.id)) return;
    try {
      await registry.register(adapter, opts.signal ? { signal: opts.signal } : undefined);
      statuses.push({ id: adapter.id, kind, available: true });
    } catch (e) {
      statuses.push({ id: adapter.id, kind, available: false, detail: (e as Error).message });
    }
  };

  // Built-in mock, always present.
  await register(createMockAdapter(), "mock");

  // User/project-configured providers win over the defaults (registered next).
  for (const pcRaw of config.providers) {
    if (registry.has(pcRaw.id)) continue;
    // Route this provider through its private gateway (if one governs it). The
    // rewrite runs the egress-allowlist check (fail-closed) and overrides the
    // endpoint; the result is merged back onto the full ProviderConfig.
    const gw = gateways ? resolveGateway(pcRaw.id, gateways) : undefined;
    let pc: ProviderConfig = pcRaw;
    let gatewayHeaders: Record<string, string> | undefined;
    if (gw) {
      // Merge the provider's OWN static headers with the gateway's injected
      // headers (signed org token / x-org-id, …). The rewrite overrides the
      // endpoint and MERGES headers (gateway wins on a clash by default); we thread
      // BOTH the new baseUrl and the merged headers to the adapter below so a real
      // gateway that requires auth is not rejected for missing headers.
      // A provider config MAY carry its own static headers (accessed defensively:
      // the frozen `ProviderConfig` does not declare a `headers` key today, but
      // reading it this way keeps the merge correct if one is added later).
      const ownHeaders = (pcRaw as { headers?: Record<string, string> }).headers;
      const applied = applyGateway(
        {
          id: pcRaw.id,
          baseUrl: pcRaw.baseUrl,
          ...(ownHeaders ? { headers: ownHeaders } : {}),
        } as GatewayableProviderConfig,
        gw,
      );
      pc = { ...pcRaw, ...(applied.baseUrl !== undefined ? { baseUrl: applied.baseUrl } : {}) };
      gatewayHeaders = applied.headers;
    }
    const { adapter, detail } = await loadConfiguredAdapter(pc, secrets, gatewayHeaders, opts.authRegistry);
    if (adapter) {
      await register(adapter, pc.kind);
    } else {
      statuses.push({ id: pc.id, kind: pc.kind, available: false, ...(detail ? { detail } : {}) });
    }
  }

  // Offline mock variants for failover / latency demos + tests.
  await register(createFlakyMockAdapter(), "mock");
  await register(createSlowMockAdapter(), "mock");

  // Default cloud catalog (offline registration; "needs key" until credentialed).
  await registerDefaultCloudProviders(registry, secrets, statuses);

  // Default "anthropic" (OAuth "login like Claude Code" + api-key): registered
  // ONLY when the caller opted into auth-aware credential resolution (passed an
  // `authRegistry`) and has no explicit `providers[]` entry for it already — see
  // registerDefaultAnthropicProvider's doc comment for the first-run gap this
  // closes (signed in via `nexus login anthropic`, but bare `nexus` still fell
  // back to mock because "anthropic" was never registered at all).
  if (opts.authRegistry) {
    await registerDefaultAnthropicProvider(registry, secrets, statuses, opts.authRegistry, opts.signal);
  }

  // Subprocess coding-CLI catalog (claude-code, codex): offline registration,
  // "not installed" when the binary is absent — never a crash.
  await registerSubprocessProviders(registry, statuses);

  // Native cloud-model catalog (gemini, bedrock, vertex): offline registration,
  // "needs key/creds" until credentialed — never a crash.
  await registerDefaultNativeProviders(registry, secrets, statuses, config);

  // Register heavy subsystems as lazy cells — constructed on first use only
  // (system-spec §23: lazy loading). With `performance.lazy` on (the default),
  // nothing here is built during bootstrap — each is constructed on first
  // `subsystems.get(name)`, so startup and one-shot `ask` stay fast. When
  // `performance.lazy` is false the caller opts OUT of deferral: every registered
  // subsystem is eagerly constructed now (warm-start / long-lived daemon).
  const subsystems = new LazySubsystems();
  if (opts.subsystems) {
    for (const [name, factory] of Object.entries(opts.subsystems)) subsystems.register(name, factory);
    if (!config.performance.lazy) {
      for (const name of subsystems.names()) subsystems.get(name);
    }
  }

  return { registry, secrets, pricing: pricingTable(config), statuses, subsystems };
}

/** Router cost/latency/quality metadata assembled from the loaded config. */
export function routerMetadataFrom(config: NexusConfig): {
  pricing: ReturnType<typeof pricingTable>;
  latency: Record<string, number>;
  quality: string[];
} {
  return { pricing: pricingTable(config), latency: config.latency, quality: config.quality };
}
