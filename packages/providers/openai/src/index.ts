/**
 * @nexuscode/provider-openai — the native OpenAI adapter plus the generic
 * OpenAI-compatible transport (`createOpenAICompatAdapter`) reused by Grok,
 * Ollama, Groq, DeepSeek, Mistral and any `/v1/chat/completions` backend.
 *
 * Wire format is Chat Completions (universally supported), so one converter and
 * one streaming state machine serve every OpenAI-shaped provider. Retries are
 * owned by `@nexuscode/core` (`maxRetries: 0` on the SDK); `ctx.signal` is
 * honored end-to-end and surfaces as a non-retryable `cancelled` on abort.
 *
 * No network I/O runs at import time — SDK clients are built lazily on the
 * first `chat` / `stream` / `health` call.
 */

export {
  createOpenAICompatAdapter,
  createOpenAIAdapter,
  createGrokAdapter,
  grokCompatConfig,
  DEFAULT_OPENAI_MODELS,
  DEFAULT_OPENAI_EMBED_MODEL,
  DEFAULT_GROK_MODELS,
  type OpenAICompatConfig,
  type OpenAIAdapterOptions,
  type GrokConfigOptions,
  type ApiKeyProvider,
} from "./adapter.js";

export {
  // config + adapter factories
  groqCompatConfig,
  createGroqAdapter,
  togetherCompatConfig,
  createTogetherAdapter,
  deepseekCompatConfig,
  createDeepSeekAdapter,
  mistralCompatConfig,
  createMistralAdapter,
  openrouterCompatConfig,
  createOpenRouterAdapter,
  nvidiaCompatConfig,
  createNvidiaAdapter,
  lmstudioCompatConfig,
  createLmStudioAdapter,
  vllmCompatConfig,
  createVllmAdapter,
  // registry
  COMPAT_PROVIDER_CONFIGS,
  COMPAT_PROVIDER_IDS,
  createCompatAdapter,
  // env var names
  GROQ_API_KEY_ENV,
  TOGETHER_API_KEY_ENV,
  DEEPSEEK_API_KEY_ENV,
  MISTRAL_API_KEY_ENV,
  OPENROUTER_API_KEY_ENV,
  NVIDIA_API_KEY_ENV,
  type CompatProviderOptions,
} from "./compat.js";

export { mapOpenAIError, parseRetryAfterMs, redactSecrets } from "./errors.js";
export { usageFrom, type StreamOptions } from "./stream.js";
export {
  buildStreamingBody,
  toOpenAIMessages,
  toOpenAITools,
  toOpenAIToolChoice,
  type BodyOptions,
} from "./convert.js";
