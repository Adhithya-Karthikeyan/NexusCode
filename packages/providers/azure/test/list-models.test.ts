import { describe, it, expect } from "vitest";
import type OpenAI from "openai";
import { azureOpenAICompatConfig } from "@nexuscode/provider-azure";
import { createOpenAICompatAdapter } from "@nexuscode/provider-openai";

/**
 * Azure OpenAI is a thin config over the OpenAI-compat transport, so it inherits
 * `listModels()`. Since `AzureOpenAI extends OpenAI`, the SDK's `models.list()`
 * works when reachable; when it doesn't, the adapter degrades to the curated
 * catalog (the deployment). Verified offline by overriding the config's client
 * seam — no Azure endpoint is contacted.
 */
describe("azure — listModels", () => {
  it("exposes listModels on the built adapter", () => {
    const adapter = azureOpenAICompatConfig({
      endpoint: "https://x.openai.azure.com",
      apiVersion: "2024-10-21",
      deployment: "gpt-4o",
    });
    const built = createOpenAICompatAdapter(adapter);
    expect(typeof built.listModels).toBe("function");
  });

  it("lists live deployment ids when the endpoint is reachable", async () => {
    const cfg = azureOpenAICompatConfig({
      endpoint: "https://x.openai.azure.com",
      apiVersion: "2024-10-21",
      deployment: "gpt-4o",
      apiKey: "azure-key",
    });
    cfg.createClient = () =>
      ({ models: { list: async () => ({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }) } }) as unknown as OpenAI;
    const models = await createOpenAICompatAdapter(cfg).listModels!();
    expect(models.map((m) => m.id)).toEqual(["gpt-4o", "gpt-4o-mini"]);
  });

  it("falls back to the deployment catalog when the endpoint errors", async () => {
    const cfg = azureOpenAICompatConfig({
      endpoint: "https://x.openai.azure.com",
      apiVersion: "2024-10-21",
      deployment: "my-deploy",
      apiKey: "azure-key",
    });
    cfg.createClient = () =>
      ({
        models: {
          list: async () => {
            throw new Error("unreachable");
          },
        },
      }) as unknown as OpenAI;
    const models = await createOpenAICompatAdapter(cfg).listModels!();
    expect(models.map((m) => m.id)).toEqual(["my-deploy"]);
  });
});
