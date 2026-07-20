import { describe, it, expect } from "vitest";
import { createBedrockAdapter } from "@nexuscode/provider-bedrock";

/**
 * The Bedrock *runtime* client (Converse) has no model-listing operation, so
 * `listModels()` returns the curated, config-driven catalog derived from the
 * modelMap — its OWN models, never the global catalog. Offline, no AWS creds.
 */
describe("bedrock — listModels", () => {
  it("returns the config-driven Bedrock model catalog", async () => {
    const adapter = createBedrockAdapter({
      modelMap: {
        default: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        nova: "amazon.nova-pro-v1:0",
      },
    });
    const ids = (await adapter.listModels!()).map((m) => m.id).sort();
    expect(ids).toEqual(
      ["amazon.nova-pro-v1:0", "anthropic.claude-3-5-sonnet-20241022-v2:0"].sort(),
    );
  });

  it("matches capabilities().models (single source of truth) and never throws", async () => {
    const adapter = createBedrockAdapter({ modelMap: { default: "meta.llama3-70b" } });
    const listed = await adapter.listModels!();
    const caps = await adapter.capabilities();
    expect(listed).toEqual(caps.models);
  });
});
