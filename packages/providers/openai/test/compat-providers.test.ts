import { describe, it, expect } from "vitest";
import {
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
  createCompatAdapter,
  COMPAT_PROVIDER_IDS,
  COMPAT_PROVIDER_CONFIGS,
  GROQ_API_KEY_ENV,
  DEEPSEEK_API_KEY_ENV,
  type OpenAICompatConfig,
} from "@nexuscode/provider-openai";
import type { ProviderAdapter } from "@nexuscode/core";

/**
 * Each ready compat provider: correct id/label, correct baseURL, correct auth
 * posture, and a non-empty model catalog + modelMap seam — all verified offline
 * (no network, no keys). We assert on both the config (which carries baseURL and
 * requiresAuth) and the built adapter (which carries id/label/transport/caps).
 */

interface Case {
  id: string;
  label: string;
  baseURL: string;
  requiresAuth: boolean;
  config: (o?: unknown) => OpenAICompatConfig;
  adapter: () => ProviderAdapter;
}

const CASES: Case[] = [
  { id: "groq", label: "Groq", baseURL: "https://api.groq.com/openai/v1", requiresAuth: true, config: groqCompatConfig, adapter: createGroqAdapter },
  { id: "together", label: "Together AI", baseURL: "https://api.together.xyz/v1", requiresAuth: true, config: togetherCompatConfig, adapter: createTogetherAdapter },
  { id: "deepseek", label: "DeepSeek", baseURL: "https://api.deepseek.com/v1", requiresAuth: true, config: deepseekCompatConfig, adapter: createDeepSeekAdapter },
  { id: "mistral", label: "Mistral AI", baseURL: "https://api.mistral.ai/v1", requiresAuth: true, config: mistralCompatConfig, adapter: createMistralAdapter },
  { id: "openrouter", label: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", requiresAuth: true, config: openrouterCompatConfig, adapter: createOpenRouterAdapter },
  { id: "nvidia", label: "NVIDIA NIM", baseURL: "https://integrate.api.nvidia.com/v1", requiresAuth: true, config: nvidiaCompatConfig, adapter: createNvidiaAdapter },
  { id: "lmstudio", label: "LM Studio (local)", baseURL: "http://localhost:1234/v1", requiresAuth: false, config: lmstudioCompatConfig, adapter: createLmStudioAdapter },
  { id: "vllm", label: "vLLM (local)", baseURL: "http://localhost:8000/v1", requiresAuth: false, config: vllmCompatConfig, adapter: createVllmAdapter },
];

describe.each(CASES)("compat provider — $id", (c) => {
  it("config carries the correct baseURL, id and auth posture", () => {
    const cfg = c.config();
    expect(cfg.id).toBe(c.id);
    expect(cfg.baseURL).toBe(c.baseURL);
    expect(cfg.requiresAuth).toBe(c.requiresAuth);
    expect(cfg.label).toBe(c.label);
  });

  it("config exposes a non-empty model catalog and a modelMap seam", () => {
    const cfg = c.config();
    expect(cfg.models && cfg.models.length).toBeGreaterThan(0);
    expect(cfg.modelMap && Object.keys(cfg.modelMap).length).toBeGreaterThan(0);
    // A "default" logical alias always resolves to some native model id.
    expect(cfg.modelMap?.default).toBeTruthy();
  });

  it("adapter builds with the right identity + transport and reports capabilities", async () => {
    const adapter = c.adapter();
    expect(adapter.id).toBe(c.id);
    expect(adapter.label).toBe(c.label);
    expect(adapter.transport).toBe("http-openai-compat");
    const caps = await adapter.capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.cancel).toBe("abort-signal");
    expect(caps.models.length).toBeGreaterThan(0);
  });

  it("baseURL and modelMap are overridable through options", () => {
    const cfg = c.config({ baseURL: "http://example.test/v1", modelMap: { default: "custom-x" } });
    expect(cfg.baseURL).toBe("http://example.test/v1");
    expect(cfg.modelMap?.default).toBe("custom-x");
  });
});

describe("compat providers — auth env seam", () => {
  it("auth-required providers default to a lazy env-var credential resolver", async () => {
    const cfg = groqCompatConfig();
    expect(typeof cfg.apiKey).toBe("function");
    const prev = process.env[GROQ_API_KEY_ENV];
    process.env[GROQ_API_KEY_ENV] = "gk_test_123";
    try {
      const resolver = cfg.apiKey as () => string | Promise<string>;
      await expect(Promise.resolve(resolver())).resolves.toBe("gk_test_123");
    } finally {
      if (prev === undefined) delete process.env[GROQ_API_KEY_ENV];
      else process.env[GROQ_API_KEY_ENV] = prev;
    }
  });

  it("an explicit apiKey overrides the env resolver", () => {
    const cfg = deepseekCompatConfig({ apiKey: "sk-literal" });
    expect(cfg.apiKey).toBe("sk-literal");
    expect(DEEPSEEK_API_KEY_ENV).toBe("DEEPSEEK_API_KEY");
  });

  it("local backends are auth-less and zero-cost", () => {
    for (const id of ["lmstudio", "vllm"]) {
      const cfg = COMPAT_PROVIDER_CONFIGS[id]!();
      expect(cfg.requiresAuth).toBe(false);
      expect(cfg.zeroCost).toBe(true);
      // No default credential resolver is attached for an auth-less backend.
      expect(cfg.apiKey).toBeUndefined();
    }
  });

  it("deepseek advertises reasoning capability", async () => {
    const caps = await createDeepSeekAdapter().capabilities();
    expect(caps.reasoning).toBe(true);
  });
});

describe("compat providers — registry", () => {
  it("exposes all eight provider ids", () => {
    expect([...COMPAT_PROVIDER_IDS].sort()).toEqual(
      ["deepseek", "groq", "lmstudio", "mistral", "nvidia", "openrouter", "together", "vllm"].sort(),
    );
  });

  it("createCompatAdapter builds any registered id and rejects unknown ids", () => {
    for (const id of COMPAT_PROVIDER_IDS) {
      expect(createCompatAdapter(id).id).toBe(id);
    }
    expect(() => createCompatAdapter("nope")).toThrow(/unknown/i);
  });
});
