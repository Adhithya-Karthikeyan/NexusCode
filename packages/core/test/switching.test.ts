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

// ── switching to a target that can't accept tool-call history ──────────────
// Before `toolExchange` (see `agent.test.ts`/`tool-exchange-hardening.test
// .ts`), a transcript never contained tool blocks, so this was inert. Now it
// persists — so a switch target whose `caps.tools` is false must be refused,
// not accepted and left to 400 on the provider's own wire format on the NEXT
// turn, misattributed to whatever that turn happened to be.

const NO_TOOLS_CAPS: Capabilities = {
  models: [{ id: "plain-model", contextWindow: 32_000 }],
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

const WITH_TOOLS_CAPS: Capabilities = { ...NO_TOOLS_CAPS, tools: true };

const TOOL_USE_MSG = {
  role: "assistant" as const,
  content: [{ type: "tool_use" as const, id: "call_1", name: "echo", input: {} }],
};
const TOOL_RESULT_MSG = {
  role: "tool" as const,
  toolCallId: "call_1",
  content: [{ type: "text" as const, text: "echoed" }],
};

describe("switching — a target that can't accept tool-call history is blocked", () => {
  it("inferSwitchRequirements sets hasToolHistory from the transcript, not from request.tools", () => {
    const withHistory: ChatRequest = {
      model: "m",
      messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        TOOL_USE_MSG,
        TOOL_RESULT_MSG,
      ],
    };
    const withoutHistory: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    expect(inferSwitchRequirements(withHistory).hasToolHistory).toBe(true);
    expect(inferSwitchRequirements(withoutHistory).hasToolHistory).toBe(false);
    // A switch control line offers no tools of its own for the next turn —
    // `tools` (a different requirement) stays false even though the
    // conversation already has tool-call content.
    expect(inferSwitchRequirements(withHistory).tools).toBe(false);
  });

  it("blocks a switch to a tools-incapable target when the transcript has tool history, naming both real options", () => {
    const request: ChatRequest = {
      model: "m",
      messages: [TOOL_USE_MSG, TOOL_RESULT_MSG],
    };
    const assessment = assessSwitchTarget(
      "plain-provider",
      "plain-model",
      NO_TOOLS_CAPS,
      inferSwitchRequirements(request),
    );
    expect(assessment.compatible).toBe(false);
    const blocker = assessment.blockers.find((b) => b.includes("tool-call history"));
    expect(blocker).toContain("plain-provider");
    expect(blocker).toContain("stay on the current provider");
    expect(blocker).toContain("start a new conversation without that history");
  });

  it("does NOT block when the target supports tools, even with tool history present", () => {
    const request: ChatRequest = { model: "m", messages: [TOOL_USE_MSG, TOOL_RESULT_MSG] };
    const assessment = assessSwitchTarget(
      "tool-provider",
      "plain-model",
      WITH_TOOLS_CAPS,
      inferSwitchRequirements(request),
    );
    expect(assessment.compatible).toBe(true);
    expect(assessment.blockers).toEqual([]);
  });

  it("does NOT block a tools-incapable target when the transcript has no tool history", () => {
    const request: ChatRequest = {
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    const assessment = assessSwitchTarget(
      "plain-provider",
      "plain-model",
      NO_TOOLS_CAPS,
      inferSwitchRequirements(request),
    );
    expect(assessment.compatible).toBe(true);
  });

  it("blocked means blocked: adaptRequestForSwitch (what performSwitch calls) refuses rather than switching anyway", () => {
    const request: ChatRequest = { model: "m", messages: [TOOL_USE_MSG, TOOL_RESULT_MSG] };
    const assessment = assessSwitchTarget(
      "plain-provider",
      "plain-model",
      NO_TOOLS_CAPS,
      inferSwitchRequirements(request),
    );
    expect(() => adaptRequestForSwitch(request, assessment)).toThrow(/tool-call history/);
  });

  it("automatic failover (compatibleSwitchCandidates) also excludes a tools-incapable target once the conversation has tool history", async () => {
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ id: "source", models: ["source-tools"] }), {
      skipHealth: true,
    });
    await registry.register(createMockAdapter({ id: "plain-only", models: ["plain-model"] }), {
      skipHealth: true,
    });
    const request: ChatRequest = { model: "source-tools", messages: [TOOL_USE_MSG, TOOL_RESULT_MSG] };
    const rows = compatibleSwitchCandidates(
      registry,
      { providerId: "source", modelId: "source-tools", reason: "explicit" },
      request,
      { policy: "fallback", allowProviders: ["plain-only"] },
    );
    expect(rows).toEqual([]);
  });
});
