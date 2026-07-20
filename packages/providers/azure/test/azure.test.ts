import { describe, it, expect } from "vitest";
import {
  createAzureOpenAIAdapter,
  azureOpenAICompatConfig,
  AZURE_OPENAI_API_KEY_ENV,
} from "@nexuscode/provider-azure";
import type { CallContext } from "@nexuscode/core";

const OPTS = {
  endpoint: "https://my-resource.openai.azure.com",
  apiVersion: "2024-10-21",
  deployment: "gpt-4o-prod",
};

function ctx(signal: AbortSignal): CallContext {
  return { signal, idempotencyKey: "idem", traceId: "trace", runId: "run_azure" };
}

describe("azure openai adapter — construction (offline, no creds)", () => {
  it("builds the adapter with the expected identity and native transport", async () => {
    const adapter = createAzureOpenAIAdapter(OPTS);
    expect(adapter.id).toBe("azure-openai");
    expect(adapter.label).toBe("Azure OpenAI");
    expect(adapter.transport).toBe("http-sdk");
  });

  it("reports capabilities without any network call", async () => {
    const caps = await createAzureOpenAIAdapter(OPTS).capabilities();
    expect(caps.streaming).toBe(true);
    expect(caps.vision).toBe(true);
    expect(caps.reasoning).toBe(true);
    expect(caps.cancel).toBe("abort-signal");
    // The deployment surfaces as the advertised model.
    expect(caps.models.some((m) => m.id === "gpt-4o-prod")).toBe(true);
  });

  it("config carries the azure client seam and a deployment modelMap", () => {
    const cfg = azureOpenAICompatConfig(OPTS);
    expect(cfg.requiresAuth).toBe(true);
    expect(cfg.transport).toBe("http-sdk");
    expect(cfg.modelMap?.default).toBe("gpt-4o-prod");
    // A createClient seam is present (built lazily; not invoked here).
    expect(typeof cfg.createClient).toBe("function");
  });

  it("defaults to a lazy env-var credential resolver", async () => {
    const cfg = azureOpenAICompatConfig(OPTS);
    expect(typeof cfg.apiKey).toBe("function");
    const prev = process.env[AZURE_OPENAI_API_KEY_ENV];
    process.env[AZURE_OPENAI_API_KEY_ENV] = "az_test_key";
    try {
      const resolver = cfg.apiKey as () => string | Promise<string>;
      await expect(Promise.resolve(resolver())).resolves.toBe("az_test_key");
    } finally {
      if (prev === undefined) delete process.env[AZURE_OPENAI_API_KEY_ENV];
      else process.env[AZURE_OPENAI_API_KEY_ENV] = prev;
    }
  });
});

describe("azure openai adapter — no-network failure posture", () => {
  it("with no credential, chat fails fast with a non-retryable auth error (never hits the network)", async () => {
    // Ensure no ambient key so the resolver returns empty and auth fails before
    // any AzureOpenAI client is constructed or any request is made.
    const prev = process.env[AZURE_OPENAI_API_KEY_ENV];
    delete process.env[AZURE_OPENAI_API_KEY_ENV];
    try {
      const adapter = createAzureOpenAIAdapter(OPTS);
      const ac = new AbortController();
      const chunks = [];
      for await (const c of adapter.stream(
        { model: "default", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
        ctx(ac.signal),
      )) {
        chunks.push(c);
      }
      const err = chunks.find((c) => c.type === "error");
      expect(err?.type).toBe("error");
      if (err?.type !== "error") throw new Error("expected error chunk");
      expect(err.error.code).toBe("auth");
      expect(err.retryable).toBe(false);
    } finally {
      if (prev !== undefined) process.env[AZURE_OPENAI_API_KEY_ENV] = prev;
    }
  });
});
