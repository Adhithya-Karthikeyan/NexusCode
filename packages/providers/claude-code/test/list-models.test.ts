import { describe, it, expect } from "vitest";
import { createClaudeCodeAdapter, CLAUDE_CODE_MODELS } from "@nexuscode/provider-claude-code";

/**
 * A wrapped coding CLI has no models API, so `listModels()` returns the curated
 * vendor catalog of `claude`-selectable models (including a `"default"` entry for
 * the CLI's own default), unioned with any config-driven modelMap entries.
 * Deterministic and offline — no CLI is spawned.
 */
describe("claude-code — listModels", () => {
  it("returns the curated Claude CLI model catalog", async () => {
    const adapter = createClaudeCodeAdapter();
    const ids = (await adapter.listModels!()).map((m) => m.id);
    expect(ids).toEqual(CLAUDE_CODE_MODELS.map((m) => m.id));
    // The CLI's own default is offered.
    expect(ids).toContain("default");
    // Anthropic Claude models — not any other vendor's.
    expect(ids).toContain("opus");
    expect(ids.some((id) => id.startsWith("claude-"))).toBe(true);
    expect(ids.some((id) => id.startsWith("gpt-"))).toBe(false);
  });

  it("unions config-driven modelMap entries on top of the curated catalog", async () => {
    const adapter = createClaudeCodeAdapter({ modelMap: { custom: "claude-custom-9" } });
    const ids = (await adapter.listModels!()).map((m) => m.id);
    expect(ids).toContain("claude-custom-9");
    // Curated entries are still present.
    expect(ids).toContain("default");
  });
});
