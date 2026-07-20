import { describe, it, expect } from "vitest";
import { createCodexAdapter, CODEX_MODELS } from "@nexuscode/provider-codex";

/**
 * A wrapped coding CLI has no models API, so `listModels()` returns the curated
 * vendor catalog of `codex`-selectable OpenAI models (including a `"default"`
 * entry), unioned with any config-driven modelMap entries. Deterministic and
 * offline — no CLI is spawned.
 */
describe("codex — listModels", () => {
  it("returns the curated Codex CLI model catalog", async () => {
    const adapter = createCodexAdapter();
    const ids = (await adapter.listModels!()).map((m) => m.id);
    expect(ids).toEqual(CODEX_MODELS.map((m) => m.id));
    expect(ids).toContain("default");
    // OpenAI/codex models — not any other vendor's.
    expect(ids.some((id) => id.startsWith("gpt-") || id.startsWith("o"))).toBe(true);
    expect(ids.some((id) => id.startsWith("claude-"))).toBe(false);
  });

  it("unions config-driven modelMap entries on top of the curated catalog", async () => {
    const adapter = createCodexAdapter({ modelMap: { custom: "gpt-custom-9" } });
    const ids = (await adapter.listModels!()).map((m) => m.id);
    expect(ids).toContain("gpt-custom-9");
    expect(ids).toContain("default");
  });
});
