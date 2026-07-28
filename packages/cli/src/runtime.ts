/**
 * The runtime bootstrap now lives in `@nexuscode/runtime` so the CLI, the
 * embeddable SDK, and the REST daemon all share one provider-assembly path
 * (the engine stays the single source of truth). This module is a thin
 * re-export kept for the CLI's existing `./runtime.js` import sites, plus a
 * small CLI-only first-run fallback policy (below) for the DEFAULT (no
 * explicit `-p`) provider path.
 */

import type { CallContext } from "@nexuscode/core";
import type { NexusConfig } from "@nexuscode/config";
import { buildRuntime, type Runtime } from "@nexuscode/runtime";
import { buildAuthRegistry, resolveAuthSecrets } from "./auth.js";

export {
  routerMetadataFrom,
  binaryOnPath,
  probeLocalServerReachability,
  LOCAL_SERVER_PROBE_TIMEOUT_MS,
  type ProviderStatus,
} from "@nexuscode/runtime";
export { buildRuntime, type Runtime };

/**
 * Build the runtime with the per-provider {@link ProviderAuthRegistry} wired
 * (Wave 13): credential resolution for a provider that has been logged in goes
 * through its auth strategy — an auto-refreshed OAuth Bearer (Anthropic "login
 * like Claude Code"), an API key, a wrapped-CLI session, or the cloud credential
 * chain — instead of the legacy env/api-key-only path. Fully additive: a
 * provider with no strategy (e.g. `mock`) resolves exactly as before, and the
 * env-var + `keys set` paths keep working (the api-key strategy reads the same
 * env var / SecretStore ref). Shares ONE SecretStore between the auth registry
 * and the runtime so a token stored at login is resolvable here.
 *
 * This is the DEFAULT runtime builder for any command that resolves,
 * validates, lists, or reports on providers by id — `buildRuntime` alone
 * cannot see a provider the user is only logged into via OAuth (no static
 * `providers[]` config entry), which is what let `anthropic` silently vanish
 * from `nexus providers`/`models`/`doctor`/`route`/etc despite a valid `nexus
 * login anthropic` session. Reach for the plain (unauthed) `buildRuntime`
 * export only when a command must describe the static config rather than the
 * live signed-in session (see `nexus mcp`'s use in `packages/cli/src/commands.ts`,
 * which only needs a SecretStore for MCP server secret refs and never resolves
 * a provider id).
 */
export async function buildAuthedRuntime(
  config: NexusConfig,
  opts: Parameters<typeof buildRuntime>[1] = {},
): Promise<Runtime> {
  const secrets = opts.secrets ?? resolveAuthSecrets(config);
  const authRegistry = buildAuthRegistry(config, secrets);
  return buildRuntime(config, { ...opts, secrets, authRegistry });
}

/** One provider→model row for the TUI `/model` picker (a single provider's list). */
export interface ProviderModelChoice {
  provider: string;
  model: string;
  hint?: string;
  /**
   * The model's real context window, when the provider reported one. Carried
   * alongside the display `hint` so a switch can size the HUD gauge for the model
   * the user actually picked instead of guessing from the curated snapshot.
   */
  contextWindow?: number;
}

/** How long a live `listModels()` probe may run before we fall back to curated. */
const LIST_MODELS_TIMEOUT_MS = 4000;

/** Drop duplicate / empty model ids, preserving first-seen order. */
function dedupeById<T extends { id: string }>(models: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const m of models) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    out.push(m);
  }
  return out;
}

/**
 * Resolve the model list for ONE provider — the models the `/model` picker must
 * scope to. Prefers the adapter's REAL model discovery (`adapter.listModels()`,
 * which hits the provider's own models endpoint), and falls back to the curated
 * static `capabilities().models` whenever the provider can't be listed (no key,
 * offline, or no list endpoint). Never throws: an unknown provider yields `[]`
 * and any discovery failure degrades to the curated catalog.
 *
 * This is the runtime helper the TUI's `/model` optionsProvider calls, so the
 * picker shows only the ACTIVE provider's models instead of the global
 * cross-provider catalog (the bug this fixes).
 */
export async function listModelsForProvider(
  runtime: Runtime,
  providerId: string,
): Promise<ProviderModelChoice[]> {
  if (!runtime.registry.has(providerId)) return [];

  const toChoice = (m: { id: string; contextWindow?: number }): ProviderModelChoice => ({
    provider: providerId,
    model: m.id,
    ...(m.contextWindow ? { hint: `${Math.round(m.contextWindow / 1000)}k ctx` } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
  });
  const curated = (): ProviderModelChoice[] => {
    try {
      return dedupeById(runtime.registry.capabilitiesOf(providerId).models).map(toChoice);
    } catch {
      return [];
    }
  };

  const adapter = runtime.registry.get(providerId);
  if (typeof adapter.listModels !== "function") return curated();

  // Bound the live probe so a hung endpoint never stalls the picker.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_MODELS_TIMEOUT_MS);
  const ctx: CallContext = {
    signal: controller.signal,
    idempotencyKey: `listModels:${providerId}`,
    traceId: `listModels:${providerId}`,
    runId: `listModels:${providerId}`,
  };
  try {
    const live = await adapter.listModels(ctx);
    const rows = dedupeById(live).map(toChoice);
    return rows.length > 0 ? rows : curated();
  } catch {
    return curated();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Local, non-network providers preferred as a first-run fallback right after
 * `mock` — a machine with a reachable local model still gets a real answer
 * instead of the mock echo.
 */
const LOCAL_FALLBACK_PROVIDER_IDS = ["ollama", "lmstudio", "vllm"] as const;

/**
 * True when `id` is registered AND has a usable credential of ANY kind: needs
 * none (`mock`/local providers), an API key resolvable via the SecretStore/env,
 * a stored non-expired OAuth token (Anthropic "login like Claude Code"), or a
 * detected vendor-CLI session (claude-code/codex) — a provider the user has
 * `nexus login`-ed into must count as usable, not just one with a raw key. A
 * provider that is registered but only "needs key" (offline registration, lazy
 * credential check) is NOT usable — dispatching through it would fail on the
 * first real call.
 *
 * The OAuth-token check happens up front, at `buildRuntime` time: when a caller
 * supplies an auth registry (`buildAuthedRuntime`), `@nexuscode/runtime` itself
 * consults it — `registerDefaultAnthropicProvider` resolves the provider's auth
 * strategy credential (a stored OAuth bearer token, or its own api-key
 * fallback) and folds the result into `status.needsKey` — so this single
 * `available && !needsKey` check already reflects a `nexus login` just as much
 * as a `keys set`. No separate live OAuth probe belongs HERE: this function
 * must stay synchronous (every caller — `pickFallbackProviderId`,
 * `resolveDefaultProvider`, and their command-layer callers — is synchronous
 * too), and a token/TokenStore read is inherently async.
 */
export function isProviderUsable(runtime: Runtime, id: string): boolean {
  if (!runtime.registry.has(id)) return false;
  const status = runtime.statuses.find((s) => s.id === id);
  return status ? status.available && !status.needsKey : true;
}

/**
 * Pick the best fallback provider when the requested default has no usable
 * credential: `mock` first (always available, fully offline), then a
 * reachable local provider, then anything else that is actually usable.
 * `undefined` only when NOTHING is usable — should never happen since `mock`
 * is always registered by {@link buildRuntime}.
 */
export function pickFallbackProviderId(runtime: Runtime): string | undefined {
  if (isProviderUsable(runtime, "mock")) return "mock";
  for (const id of LOCAL_FALLBACK_PROVIDER_IDS) {
    if (isProviderUsable(runtime, id)) return id;
  }
  for (const status of runtime.statuses) {
    if (isProviderUsable(runtime, status.id)) return status.id;
  }
  return undefined;
}

/** The outcome of resolving a DEFAULT (no explicit `-p`) provider request. */
export interface ProviderResolution {
  /** The provider id to actually dispatch through. */
  providerId: string;
  /** True when `providerId` differs from `requestedId` (a fallback happened). */
  fellBack: boolean;
  /** The originally requested (configured default) provider id. */
  requestedId: string;
}

/**
 * Resolve the provider for a DEFAULT (no explicit `-p`) run: a brand-new user
 * must never be dead-ended by an unconfigured `defaultProvider` (first-run
 * UX — bare `nexus`/`nexus tui`/`nexus ask` must always launch). When
 * `requestedId` has no usable credential, falls back per
 * {@link pickFallbackProviderId}. Returns `undefined` only when literally no
 * provider is usable. An explicit `-p <provider>` is NOT resolved here — the
 * caller validates it directly, so naming an unavailable provider still
 * errors clearly.
 */
export function resolveDefaultProvider(
  runtime: Runtime,
  requestedId: string,
): ProviderResolution | undefined {
  if (isProviderUsable(runtime, requestedId)) {
    return { providerId: requestedId, fellBack: false, requestedId };
  }
  const fallbackId = pickFallbackProviderId(runtime);
  return fallbackId ? { providerId: fallbackId, fellBack: true, requestedId } : undefined;
}
