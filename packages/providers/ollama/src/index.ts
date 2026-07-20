/**
 * @nexuscode/provider-ollama — a local-model adapter that is a thin wrapper over
 * the generic OpenAI-compatible transport from `@nexuscode/provider-openai`.
 * Ollama serves `/v1/chat/completions` on `http://localhost:11434/v1`, needs no
 * credential, and is always free — so it runs auth-less and pins `costUsd` to 0.
 */

import {
  createOpenAICompatAdapter,
  type OpenAICompatConfig,
} from "@nexuscode/provider-openai";
import { createModelListCache } from "@nexuscode/shared";
import type { CallContext, ModelInfo, ProviderAdapter } from "@nexuscode/core";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";

/** Ollama's common default embeddings model (served via `/v1/embeddings`). */
export const OLLAMA_DEFAULT_EMBED_MODEL = "nomic-embed-text";

/** Configuration for {@link createOllamaAdapter}. */
export interface OllamaConfig {
  /** Adapter id (default "ollama"). */
  id?: string;
  /** Human label (default "Ollama (local)"). */
  label?: string;
  /** Base URL of the Ollama OpenAI-compat endpoint (default localhost:11434/v1). */
  baseURL?: string;
  /** Logical model id → native model id (e.g. `"llama"` → `"llama3.2"`). */
  modelMap?: Record<string, string>;
  /** Static model catalog surfaced through `capabilities()`. */
  models?: ModelInfo[];
  /**
   * Embeddings model served over Ollama's OpenAI-compat `/v1/embeddings` endpoint.
   * Defaults to {@link OLLAMA_DEFAULT_EMBED_MODEL}, so the adapter exposes `embed()`
   * and reports `capabilities().embeddings = true`. Pass `null` to disable.
   */
  embedModel?: string | null;
  /**
   * Test/DI seam: the `fetch` used by {@link ProviderAdapter.listModels} to query
   * the local daemon's `/api/tags`. Defaults to the global `fetch`. Injected in
   * tests to parse a canned tags response with no live daemon.
   */
  fetchImpl?: typeof fetch;
}

/**
 * Build the compat config for an Ollama backend: no auth, free, local base URL.
 * Exposed so callers can register the adapter through the shared factory too.
 */
export function ollamaCompatConfig(cfg: OllamaConfig = {}): OpenAICompatConfig {
  const out: OpenAICompatConfig = {
    id: cfg.id ?? "ollama",
    label: cfg.label ?? "Ollama (local)",
    baseURL: cfg.baseURL ?? OLLAMA_DEFAULT_BASE_URL,
    // Ollama accepts (and ignores) any key; run auth-less so no secret is needed.
    requiresAuth: false,
    // Always free — report zero cost regardless of any pricing table.
    zeroCost: true,
  };
  if (cfg.modelMap !== undefined) out.modelMap = cfg.modelMap;
  if (cfg.models !== undefined) out.models = cfg.models;
  // Enable the embeddings endpoint by default; `embedModel: null` opts out.
  const embedModel = cfg.embedModel === undefined ? OLLAMA_DEFAULT_EMBED_MODEL : cfg.embedModel;
  if (embedModel) out.embedModel = embedModel;
  return out;
}

/** Derive the daemon root's native `/api/tags` URL from the OpenAI-compat base URL. */
export function ollamaTagsUrl(baseURL: string): string {
  // The compat base URL ends in `/v1`; the native tags endpoint is a sibling.
  const root = baseURL.replace(/\/v1\/?$/, "").replace(/\/$/, "");
  return `${root}/api/tags`;
}

/**
 * Query the Ollama daemon's native `GET /api/tags` and map `models[].name` to
 * {@link ModelInfo}. Unlike the API providers there is no curated fallback: a
 * local daemon that is down (or has no models pulled) genuinely has no models,
 * so this returns an empty list on any error rather than inventing entries.
 */
async function listOllamaModels(
  baseURL: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  try {
    const res = await fetchImpl(ollamaTagsUrl(baseURL), signal ? { signal } : {});
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: Array<{ name?: unknown; model?: unknown }> };
    const seen = new Set<string>();
    const out: ModelInfo[] = [];
    for (const m of body.models ?? []) {
      const name = typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : "";
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ id: name, modalities: ["text"] });
    }
    return out;
  } catch {
    // Daemon down / offline / unreachable: no models, no crash.
    return [];
  }
}

/**
 * Create an Ollama adapter. Reuses the OpenAI-compat transport verbatim with
 * Ollama's base URL and free/local pricing, and overrides `listModels` to hit
 * the daemon's native `/api/tags` (which reports the models actually pulled).
 */
export function createOllamaAdapter(cfg: OllamaConfig = {}): ProviderAdapter {
  const base = createOpenAICompatAdapter(ollamaCompatConfig(cfg));
  const baseURL = cfg.baseURL ?? OLLAMA_DEFAULT_BASE_URL;
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const cache = createModelListCache();

  // Attach the Ollama-specific `/api/tags` discovery onto the compat adapter
  // instance (which carries its transport methods on its prototype — a spread
  // copy would drop those), overriding the generic `/v1/models` path.
  base.listModels = (ctx?: CallContext): Promise<ModelInfo[]> =>
    cache.get(() => listOllamaModels(baseURL, fetchImpl, ctx?.signal));
  return base;
}
