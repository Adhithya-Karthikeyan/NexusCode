import { describe, expect, it } from "vitest";
import {
  ProviderRegistry,
  adaptRequestForSwitch,
  assessSwitchTarget,
  compatibleSwitchCandidates,
  inferSwitchRequirements,
  type ProviderAdapter,
} from "@nexuscode/core";
import { createMockAdapter } from "@nexuscode/provider-mock";
import type { Capabilities, ChatRequest } from "@nexuscode/shared";

function adapter(
  id: string,
  transport: ProviderAdapter["transport"] = "http-sdk",
  execution = false,
): ProviderAdapter {
  const base = createMockAdapter({ id, models: [`${id}-model`] });
  return {
    ...base,
    transport,
    async capabilities(): Promise<Capabilities> {
      const caps = await base.capabilities();
      return execution
        ? {
            ...caps,
            fileEdit: true,
            shellExec: true,
            git: true,
            approvalGate: true,
            mcp: true,
          }
        : caps;
    },
  };
}

const REQUEST: ChatRequest = {
  model: "source-model",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
};

describe("universal provider switching", () => {
  it("never silently falls back to mocks, unavailable providers, or stronger coding CLIs", async () => {
    const registry = new ProviderRegistry();
    await registry.register(adapter("source"), { skipHealth: true });
    await registry.register(adapter("mock-slow"), { skipHealth: true });
    await registry.register(adapter("coding-cli", "cli-subprocess", true), {
      skipHealth: true,
    });
    await registry.register(adapter("unavailable"), { skipHealth: true });
    registry.setHealth("unavailable", { ok: false, detail: "needs key" });
    await registry.register(adapter("backup"), { skipHealth: true });

    const rows = compatibleSwitchCandidates(
      registry,
      { providerId: "source", modelId: "source-model", reason: "explicit" },
      REQUEST,
      { policy: "fallback", maxFallbacks: 5 },
    );
    expect(rows.map((row) => row.candidate.providerId)).toEqual(["backup"]);
  });

  it("allows an explicitly preferred coding CLI while still requiring capability compatibility", async () => {
    const registry = new ProviderRegistry();
    await registry.register(adapter("source"), { skipHealth: true });
    await registry.register(adapter("coding-cli", "cli-subprocess", true), {
      skipHealth: true,
    });
    const rows = compatibleSwitchCandidates(
      registry,
      { providerId: "source", modelId: "source-model", reason: "explicit" },
      REQUEST,
      {
        policy: "fallback",
        preferredProviders: ["coding-cli"],
      },
    );
    expect(rows[0]?.candidate.providerId).toBe("coding-cli");
  });

  it("compacts only older history for a smaller target context", () => {
    const messages = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: `old question ${"x".repeat(1_200)}` }],
      },
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: `old answer ${"y".repeat(1_200)}` }],
      },
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "CURRENT_USER_TURN" }],
      },
    ];
    const request: ChatRequest = {
      model: "small",
      system: "PINNED_SYSTEM",
      messages,
      maxTokens: 128,
    };
    const caps: Capabilities = {
      models: [{ id: "small", contextWindow: 512 }],
      streaming: true,
      tools: false,
      parallelToolCalls: false,
      vision: false,
      structuredOutput: false,
      reasoning: false,
      systemPrompt: true,
      fileEdit: false,
      shellExec: false,
      git: false,
      approvalGate: false,
      mcp: false,
      cancel: "abort-signal",
    };
    const assessment = assessSwitchTarget(
      "target",
      "small",
      caps,
      inferSwitchRequirements(request),
      { contextSafetyMarginTokens: 64 },
    );
    const adapted = adaptRequestForSwitch(request, assessment, 64);

    expect(adapted.droppedMessages).toBeGreaterThan(0);
    expect(adapted.request.system).toBe("PINNED_SYSTEM");
    expect(JSON.stringify(adapted.request.messages)).toContain("CURRENT_USER_TURN");
    expect(adapted.adaptations[0]).toContain("compacted");
  });
});
