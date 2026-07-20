/**
 * Capabilities descriptor — frozen contract. The router negotiates over these
 * (`select(c => c.fileEdit)`) instead of hardcoding provider ids. Coding-agent
 * powers are true only for CLI/agent adapters; chat providers declare them false
 * and are simply never selected for tasks that need them.
 */

import type { Pricing } from "./usage.js";

export interface ModelInfo {
  /** Native id, e.g. "claude-sonnet-4-6". */
  id: string;
  /** Logical names mapped to this model via config. */
  aliases?: string[];
  contextWindow?: number;
  maxOutput?: number;
  /** From config, never hardcoded. */
  pricing?: Pricing;
  modalities?: ("text" | "image" | "audio")[];
}

export interface Capabilities {
  /** Probed at registration. */
  models: ModelInfo[];
  streaming: boolean;
  tools: boolean;
  parallelToolCalls: boolean;
  vision: boolean;
  /**
   * Accepts audio input content blocks (e.g. OpenAI gpt-4o-audio). Additive/optional:
   * absent is treated as `false`, so existing adapters need no change.
   */
  audio?: boolean;
  /**
   * Exposes a native embeddings endpoint via the optional `ProviderAdapter.embed()`
   * method (OpenAI `/v1/embeddings`, Ollama). Additive/optional: absent ⇒ `false`.
   */
  embeddings?: boolean;
  structuredOutput: boolean;
  reasoning: boolean;
  systemPrompt: boolean;
  // Coding-agent powers — true only for CLI adapters (and future agent SDKs):
  fileEdit: boolean;
  shellExec: boolean;
  git: boolean;
  approvalGate: boolean;
  mcp: boolean;
  /** Lets the TUI show "stopping…" vs an instant kill. */
  cancel: "abort-signal" | "process-kill";
}
