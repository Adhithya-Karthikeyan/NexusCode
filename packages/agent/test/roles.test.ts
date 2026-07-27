import { describe, it, expect } from "vitest";
import { AGENT_ROLES, createAgentRegistry } from "../src/index.js";

describe("role presets — human-facing description", () => {
  it("every shipped role has a non-empty, one-line description distinct from its system prompt", () => {
    const registry = createAgentRegistry();
    expect(AGENT_ROLES.length).toBeGreaterThan(0);
    for (const role of AGENT_ROLES) {
      const def = registry.get(role);
      // A real field, not derived by slicing `systemPrompt` — so a future
      // role added to ROLE_PRESETS without a `summary` fails here rather than
      // shipping a picker entry with nothing to show.
      expect(typeof def.description).toBe("string");
      expect(def.description?.trim().length).toBeGreaterThan(0);
      expect(def.description).not.toContain("\n");
      // It is written FOR a human choosing a role, not fed to the model: it
      // must not just restate the "You are the X…" prompt framing verbatim.
      expect(def.description?.startsWith("You are")).toBe(false);
    }
  });

  it("keeps the description out of the tool-list business — the picker already shows tools", () => {
    const registry = createAgentRegistry();
    for (const role of AGENT_ROLES) {
      const def = registry.get(role);
      for (const tool of def.allowedTools) {
        if (tool === "*") continue;
        expect(def.description?.includes(tool)).toBe(false);
      }
    }
  });
});
