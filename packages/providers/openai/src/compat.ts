/**
 * Ready OpenAI-compatible provider configs.
 *
 * Every backend below speaks `/v1/chat/completions`, so each is a small config
 * object over the shared {@link createOpenAICompatAdapter} transport rather than
 * a bespoke package. For each provider we export:
 *
 *  - `<id>CompatConfig(opts?)` → the {@link OpenAICompatConfig} (baseURL, auth,
 *    model catalog + a `modelMap` seam) so callers/tests can inspect or extend it;
 *  - `create<Id>Adapter(opts?)` → a ready {@link ProviderAdapter} over that config;
 *  - `<ID>_API_KEY_ENV` → the environment variable the default credential resolver
 *    reads (omitted for auth-less local backends).
 *
 * No network I/O happens at import or construction time — the SDK client is built
 * lazily on the first `chat`/`stream`/`health`, and the default key resolver only
 * reads `process.env` when a call actually needs a credential.
 */

import type { Capabilities, ModelInfo, ProviderAdapter } from "@nexuscode/core";
import {
  createOpenAICompatAdapter,
  type ApiKeyProvider,
  type OpenAICompatConfig,
} from "./adapter.js";

/** Per-provider overrides. All optional; every field has a sensible default. */
export interface CompatProviderOptions {
  /** Credential override. Defaults to a lazy `process.env[<ID>_API_KEY_ENV]` reader. */
  apiKey?: ApiKeyProvider;
  /** Override the base URL (e.g. a self-hosted gateway or a non-default local port). */
  baseURL?: string;
  /** logical model id → native model id. Replaces the provider's default map. */
  modelMap?: Record<string, string>;
  /** Replace the advertised model catalog. */
  models?: ModelInfo[];
}

interface CompatSpec {
  id: string;
  label: string;
  baseURL: string;
  /** Env var for the default credential resolver. `undefined` ⇒ auth-less backend. */
  apiKeyEnv?: string;
  models: ModelInfo[];
  modelMap: Record<string, string>;
  capabilities?: Partial<Capabilities>;
  /** Force `usage.costUsd = 0` for free/local backends. */
  zeroCost?: boolean;
}

/** A lazy resolver that reads the credential from the environment on first use. */
function envResolver(envVar: string): ApiKeyProvider {
  return () => process.env[envVar] ?? "";
}

/** Build an {@link OpenAICompatConfig} from a spec + caller overrides. */
function makeCompatConfig(spec: CompatSpec, opts: CompatProviderOptions = {}): OpenAICompatConfig {
  const requiresAuth = spec.apiKeyEnv !== undefined;
  const cfg: OpenAICompatConfig = {
    id: spec.id,
    label: spec.label,
    baseURL: opts.baseURL ?? spec.baseURL,
    models: opts.models ?? spec.models,
    modelMap: opts.modelMap ?? spec.modelMap,
    requiresAuth,
  };
  if (spec.capabilities) cfg.capabilities = spec.capabilities;
  if (spec.zeroCost) cfg.zeroCost = true;
  const apiKey =
    opts.apiKey ?? (spec.apiKeyEnv !== undefined ? envResolver(spec.apiKeyEnv) : undefined);
  if (apiKey !== undefined) cfg.apiKey = apiKey;
  return cfg;
}

// ── Groq ────────────────────────────────────────────────────────────────────────

export const GROQ_API_KEY_ENV = "GROQ_API_KEY";
const GROQ_SPEC: CompatSpec = {
  id: "groq",
  label: "Groq",
  baseURL: "https://api.groq.com/openai/v1",
  apiKeyEnv: GROQ_API_KEY_ENV,
  models: [
    { id: "llama-3.3-70b-versatile", contextWindow: 128_000, maxOutput: 32_768, modalities: ["text"] },
    { id: "llama-3.1-8b-instant", contextWindow: 128_000, maxOutput: 8_192, modalities: ["text"] },
    { id: "openai/gpt-oss-120b", contextWindow: 131_072, modalities: ["text"] },
  ],
  modelMap: { default: "llama-3.3-70b-versatile", fast: "llama-3.1-8b-instant" },
};
export function groqCompatConfig(opts?: CompatProviderOptions): OpenAICompatConfig {
  return makeCompatConfig(GROQ_SPEC, opts);
}
export function createGroqAdapter(opts?: CompatProviderOptions): ProviderAdapter {
  return createOpenAICompatAdapter(groqCompatConfig(opts));
}

// ── Together AI ───────────────────────────────────────────────────────────────────

export const TOGETHER_API_KEY_ENV = "TOGETHER_API_KEY";
const TOGETHER_SPEC: CompatSpec = {
  id: "together",
  label: "Together AI",
  baseURL: "https://api.together.xyz/v1",
  apiKeyEnv: TOGETHER_API_KEY_ENV,
  models: [
    { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", contextWindow: 131_072, modalities: ["text"] },
    { id: "Qwen/Qwen2.5-72B-Instruct-Turbo", contextWindow: 32_768, modalities: ["text"] },
    { id: "deepseek-ai/DeepSeek-V3", contextWindow: 131_072, modalities: ["text"] },
  ],
  modelMap: {
    default: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    fast: "Qwen/Qwen2.5-72B-Instruct-Turbo",
  },
};
export function togetherCompatConfig(opts?: CompatProviderOptions): OpenAICompatConfig {
  return makeCompatConfig(TOGETHER_SPEC, opts);
}
export function createTogetherAdapter(opts?: CompatProviderOptions): ProviderAdapter {
  return createOpenAICompatAdapter(togetherCompatConfig(opts));
}

// ── DeepSeek ──────────────────────────────────────────────────────────────────────

export const DEEPSEEK_API_KEY_ENV = "DEEPSEEK_API_KEY";
const DEEPSEEK_SPEC: CompatSpec = {
  id: "deepseek",
  label: "DeepSeek",
  baseURL: "https://api.deepseek.com/v1",
  apiKeyEnv: DEEPSEEK_API_KEY_ENV,
  models: [
    { id: "deepseek-chat", contextWindow: 64_000, maxOutput: 8_192, modalities: ["text"] },
    { id: "deepseek-reasoner", contextWindow: 64_000, maxOutput: 8_192, modalities: ["text"] },
  ],
  modelMap: { default: "deepseek-chat", reasoner: "deepseek-reasoner" },
  capabilities: { reasoning: true },
};
export function deepseekCompatConfig(opts?: CompatProviderOptions): OpenAICompatConfig {
  return makeCompatConfig(DEEPSEEK_SPEC, opts);
}
export function createDeepSeekAdapter(opts?: CompatProviderOptions): ProviderAdapter {
  return createOpenAICompatAdapter(deepseekCompatConfig(opts));
}

// ── Mistral ─────────────────────────────────────────────────────────────────────────

export const MISTRAL_API_KEY_ENV = "MISTRAL_API_KEY";
const MISTRAL_SPEC: CompatSpec = {
  id: "mistral",
  label: "Mistral AI",
  baseURL: "https://api.mistral.ai/v1",
  apiKeyEnv: MISTRAL_API_KEY_ENV,
  models: [
    { id: "mistral-large-latest", contextWindow: 131_072, modalities: ["text"] },
    { id: "mistral-small-latest", contextWindow: 131_072, modalities: ["text"] },
    { id: "codestral-latest", contextWindow: 262_144, modalities: ["text"] },
  ],
  modelMap: { default: "mistral-large-latest", fast: "mistral-small-latest", code: "codestral-latest" },
};
export function mistralCompatConfig(opts?: CompatProviderOptions): OpenAICompatConfig {
  return makeCompatConfig(MISTRAL_SPEC, opts);
}
export function createMistralAdapter(opts?: CompatProviderOptions): ProviderAdapter {
  return createOpenAICompatAdapter(mistralCompatConfig(opts));
}

// ── OpenRouter ────────────────────────────────────────────────────────────────────────

export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
const OPENROUTER_SPEC: CompatSpec = {
  id: "openrouter",
  label: "OpenRouter",
  baseURL: "https://openrouter.ai/api/v1",
  apiKeyEnv: OPENROUTER_API_KEY_ENV,
  models: [
    { id: "openai/gpt-4o", contextWindow: 128_000, modalities: ["text", "image"] },
    { id: "anthropic/claude-3.5-sonnet", contextWindow: 200_000, modalities: ["text", "image"] },
    { id: "meta-llama/llama-3.3-70b-instruct", contextWindow: 131_072, modalities: ["text"] },
  ],
  modelMap: { default: "openai/gpt-4o", claude: "anthropic/claude-3.5-sonnet" },
  capabilities: { vision: true },
};
export function openrouterCompatConfig(opts?: CompatProviderOptions): OpenAICompatConfig {
  return makeCompatConfig(OPENROUTER_SPEC, opts);
}
export function createOpenRouterAdapter(opts?: CompatProviderOptions): ProviderAdapter {
  return createOpenAICompatAdapter(openrouterCompatConfig(opts));
}

// ── NVIDIA NIM ────────────────────────────────────────────────────────────────────────

export const NVIDIA_API_KEY_ENV = "NVIDIA_API_KEY";
const NVIDIA_SPEC: CompatSpec = {
  id: "nvidia",
  label: "NVIDIA NIM",
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKeyEnv: NVIDIA_API_KEY_ENV,
  models: [
    { id: "meta/llama-3.1-70b-instruct", contextWindow: 128_000, modalities: ["text"] },
    { id: "nvidia/llama-3.1-nemotron-70b-instruct", contextWindow: 128_000, modalities: ["text"] },
  ],
  modelMap: { default: "meta/llama-3.1-70b-instruct", nemotron: "nvidia/llama-3.1-nemotron-70b-instruct" },
};
export function nvidiaCompatConfig(opts?: CompatProviderOptions): OpenAICompatConfig {
  return makeCompatConfig(NVIDIA_SPEC, opts);
}
export function createNvidiaAdapter(opts?: CompatProviderOptions): ProviderAdapter {
  return createOpenAICompatAdapter(nvidiaCompatConfig(opts));
}

// ── LM Studio (local, auth-less) ──────────────────────────────────────────────────────

const LMSTUDIO_SPEC: CompatSpec = {
  id: "lmstudio",
  label: "LM Studio (local)",
  baseURL: "http://localhost:1234/v1",
  // No apiKeyEnv ⇒ requiresAuth false: the local server needs no credential.
  models: [{ id: "local-model", contextWindow: 32_768, modalities: ["text"] }],
  modelMap: { default: "local-model" },
  zeroCost: true,
};
export function lmstudioCompatConfig(opts?: CompatProviderOptions): OpenAICompatConfig {
  return makeCompatConfig(LMSTUDIO_SPEC, opts);
}
export function createLmStudioAdapter(opts?: CompatProviderOptions): ProviderAdapter {
  return createOpenAICompatAdapter(lmstudioCompatConfig(opts));
}

// ── vLLM (local, auth-less) ──────────────────────────────────────────────────────────

const VLLM_SPEC: CompatSpec = {
  id: "vllm",
  label: "vLLM (local)",
  baseURL: "http://localhost:8000/v1",
  // No apiKeyEnv ⇒ requiresAuth false.
  models: [{ id: "local-model", contextWindow: 32_768, modalities: ["text"] }],
  modelMap: { default: "local-model" },
  zeroCost: true,
};
export function vllmCompatConfig(opts?: CompatProviderOptions): OpenAICompatConfig {
  return makeCompatConfig(VLLM_SPEC, opts);
}
export function createVllmAdapter(opts?: CompatProviderOptions): ProviderAdapter {
  return createOpenAICompatAdapter(vllmCompatConfig(opts));
}

// ── Registry ──────────────────────────────────────────────────────────────────────────

/** Every ready compat config factory, keyed by adapter id. */
export const COMPAT_PROVIDER_CONFIGS: Record<
  string,
  (opts?: CompatProviderOptions) => OpenAICompatConfig
> = {
  groq: groqCompatConfig,
  together: togetherCompatConfig,
  deepseek: deepseekCompatConfig,
  mistral: mistralCompatConfig,
  openrouter: openrouterCompatConfig,
  nvidia: nvidiaCompatConfig,
  lmstudio: lmstudioCompatConfig,
  vllm: vllmCompatConfig,
};

/** The ids of every ready OpenAI-compatible provider in this module. */
export const COMPAT_PROVIDER_IDS = Object.keys(COMPAT_PROVIDER_CONFIGS) as ReadonlyArray<string>;

/** Build a ready adapter for any registered compat provider id. */
export function createCompatAdapter(id: string, opts?: CompatProviderOptions): ProviderAdapter {
  const factory = COMPAT_PROVIDER_CONFIGS[id];
  if (!factory) throw new Error(`unknown OpenAI-compatible provider id "${id}"`);
  return createOpenAICompatAdapter(factory(opts));
}
