/**
 * @nexuscode/provider-azure — the Azure OpenAI Service as a {@link ProviderAdapter}.
 *
 * Azure speaks the Chat Completions wire format but reaches it through a
 * different client shape: an `endpoint` (your resource URL), an `apiVersion`,
 * and a `deployment` name (which stands in for the model). The official SDK
 * exposes this as `AzureOpenAI`, which *extends* `OpenAI` — so we reuse the
 * entire proven OpenAI-compatible transport (converter, streaming state machine,
 * error taxonomy) from `@nexuscode/provider-openai` and only swap in the client
 * builder via the `createClient` seam.
 *
 * No network I/O and no `AzureOpenAI` construction happen at import or at
 * adapter-build time — the client is built lazily on the first
 * `chat`/`stream`/`health`, and only after a credential is resolved. So the
 * package builds and the adapter constructs fine with no Azure credentials
 * present; an actual call with no key fails fast with a non-retryable `auth`
 * error rather than reaching out to the network.
 */

import { AzureOpenAI } from "openai";
import {
  createOpenAICompatAdapter,
  type ApiKeyProvider,
  type OpenAICompatConfig,
} from "@nexuscode/provider-openai";
import type { Capabilities, ModelInfo, ProviderAdapter } from "@nexuscode/core";

/** Env var read by the default lazy credential resolver. */
export const AZURE_OPENAI_API_KEY_ENV = "AZURE_OPENAI_API_KEY";

/** Static configuration for the Azure OpenAI adapter. */
export interface AzureOpenAIAdapterOptions {
  /** Your Azure resource endpoint, e.g. `https://my-resource.openai.azure.com`. */
  endpoint: string;
  /** The Azure API version, e.g. `"2024-10-21"`. */
  apiVersion: string;
  /**
   * The Azure *deployment* name. Azure routes by deployment rather than model,
   * so this is used both to scope the client and as the default native model.
   */
  deployment: string;
  /** Credential override. Defaults to a lazy `process.env[AZURE_OPENAI_API_KEY_ENV]` reader. */
  apiKey?: ApiKeyProvider;
  /** Adapter id. Default `"azure-openai"`. */
  id?: string;
  /** Human label for the TUI. Default `"Azure OpenAI"`. */
  label?: string;
  /** Advertised model catalog. Defaults to a single entry for the deployment. */
  models?: ModelInfo[];
  /** logical model id → native model id (deployment). Defaults to `{ default: deployment }`. */
  modelMap?: Record<string, string>;
  /** Capability overrides merged over the Azure defaults (vision + reasoning on). */
  capabilities?: Partial<Capabilities>;
}

/** A lazy resolver that reads the credential from the environment on first use. */
function envResolver(envVar: string): ApiKeyProvider {
  return () => process.env[envVar] ?? "";
}

/**
 * Build the {@link OpenAICompatConfig} for an Azure OpenAI deployment. Exposed so
 * callers/tests can inspect or extend it before creating the adapter.
 */
export function azureOpenAICompatConfig(opts: AzureOpenAIAdapterOptions): OpenAICompatConfig {
  const { endpoint, apiVersion, deployment } = opts;
  const id = opts.id ?? "azure-openai";
  const capabilities: Partial<Capabilities> = { vision: true, reasoning: true, ...opts.capabilities };
  const cfg: OpenAICompatConfig = {
    id,
    label: opts.label ?? "Azure OpenAI",
    transport: "http-sdk",
    requiresAuth: true,
    models: opts.models ?? [{ id: deployment, modalities: ["text", "image"] }],
    modelMap: opts.modelMap ?? { default: deployment },
    supportsReasoningEffort: true,
    capabilities,
    // Lazy: closes over the Azure config; AzureOpenAI is only constructed here,
    // which the transport calls on the first chat/stream/health — never at import.
    createClient: ({ apiKey }) =>
      new AzureOpenAI({ apiKey, endpoint, apiVersion, deployment, maxRetries: 0 }),
  };
  cfg.apiKey = opts.apiKey ?? envResolver(AZURE_OPENAI_API_KEY_ENV);
  return cfg;
}

/** Create the Azure OpenAI {@link ProviderAdapter}. */
export function createAzureOpenAIAdapter(opts: AzureOpenAIAdapterOptions): ProviderAdapter {
  return createOpenAICompatAdapter(azureOpenAICompatConfig(opts));
}
