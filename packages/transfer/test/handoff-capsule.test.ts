import { describe, expect, it } from "vitest";
import {
  HandoffCapsuleBudgetError,
  HandoffCapsuleIntegrityError,
  HandoffCapsuleValidationError,
  actionRetryDecision,
  createHandoffCapsule,
  deserializeHandoffCapsule,
  renderHandoffCapsuleMessage,
  renderHandoffCapsuleText,
  serializeHandoffCapsule,
  validateHandoffCapsule,
  type HandoffCapsuleInput,
} from "@nexuscode/transfer";

const NOW = "2026-07-26T10:00:00.000Z";

function input(): HandoffCapsuleInput {
  return {
    source: {
      sessionId: "session-1",
      runId: "run-claude",
      turn: 7,
      providerId: "anthropic",
      modelId: "claude",
    },
    target: { providerId: "openai", modelId: "gpt" },
    goal: {
      objective: "Ship provider-neutral continuity",
      currentGoal: "Build the handoff capsule",
      successCriteria: ["No duplicate tool calls", "No context loss"],
    },
    plan: [
      {
        id: "task-b",
        title: "Wire runtime",
        status: "pending",
        blockers: ["capsule"],
        relatedFiles: ["packages/core/src/engine.ts"],
      },
      {
        id: "task-a",
        title: "Build capsule",
        status: "in-progress",
        blockers: [],
        relatedFiles: ["packages/transfer/src/handoff-capsule.ts"],
      },
    ],
    decisions: [
      {
        id: "decision-1",
        decision: "Use canonical JSON",
        rationale: "Portable and deterministic",
        alternatives: ["vendor state"],
      },
    ],
    assumptions: [
      { id: "assumption-1", statement: "The target understands JSON", riskIfWrong: "handoff fails" },
    ],
    constraints: [
      {
        id: "constraint-1",
        kind: "must-not",
        statement: "Never replay applied changes",
        source: "user",
      },
    ],
    unresolvedQuestions: [
      { id: "question-1", question: "Which provider is next?", blocker: false },
    ],
    workspace: {
      modifiedFiles: [
        {
          path: "packages/transfer/src/handoff-capsule.ts",
          status: "added",
          summary: "Structured capsule",
          diff: "+ implementation",
        },
      ],
      commands: [
        {
          id: "command-1",
          command: "npm test",
          status: "success",
          exitCode: 0,
          summary: "green",
          output: "all passed",
        },
      ],
      tests: [
        {
          id: "test-1",
          command: "vitest",
          status: "passed",
          summary: "capsule tests passed",
        },
      ],
    },
    tools: {
      outcomes: [
        {
          actionId: "write-file-1",
          tool: "apply_patch",
          status: "success",
          summary: "file written",
          idempotent: false,
          turn: 7,
        },
        {
          actionId: "deploy-1",
          tool: "deploy",
          status: "partial",
          summary: "upload completed, activation unknown",
          partialEffect: "artifact uploaded",
          idempotent: false,
          turn: 7,
        },
      ],
      pendingApprovals: [
        {
          actionId: "publish-1",
          description: "Publish release",
          requestedBy: "agent",
        },
      ],
    },
    contextManifest: [
      {
        id: "ctx-2",
        kind: "file",
        source: "README.md",
        inclusion: "dropped",
        reason: "lower relevance",
        tokens: 100,
      },
      {
        id: "ctx-1",
        kind: "file",
        source: "packages/transfer/src/index.ts",
        inclusion: "included",
        reason: "public API",
        tokens: 200,
        content: "export *",
      },
    ],
    partialResponse: {
      text: "The implementation is partly complete.",
      finishReason: "provider-switch",
      continuationHint: "Continue with tests.",
      checkpoints: [
        {
          id: "checkpoint-1",
          offset: 22,
          summary: "Types implemented",
          completedActionIds: ["write-file-1"],
        },
      ],
    },
    doNotRepeatActionIds: ["deploy-forever"],
  };
}

describe("provider-neutral handoff capsule", () => {
  it("round-trips a signed full handoff with deterministic serialization and ordering", () => {
    const first = createHandoffCapsule(input(), { createdAt: NOW });
    const shuffled = input();
    shuffled.plan.reverse();
    shuffled.contextManifest.reverse();
    shuffled.goal.successCriteria.reverse();
    const second = createHandoffCapsule(shuffled, { createdAt: NOW });

    // Set-like arrays and entity collections serialize deterministically.
    expect(serializeHandoffCapsule(first)).toBe(serializeHandoffCapsule(second));
    expect(first.plan.map((task) => task.id)).toEqual(["task-a", "task-b"]);
    expect(deserializeHandoffCapsule(serializeHandoffCapsule(first))).toEqual(first);
    expect(first.handoff).toEqual({
      mode: "full",
      preventRetryWindow: 5,
      canExecuteActions: true,
    });
  });

  it("honors consult mode and transfer config semantics", () => {
    const capsule = createHandoffCapsule(input(), {
      createdAt: NOW,
      config: {
        compressionPolicy: "truncateMiddle",
        validationStrictness: "strict",
        handoff: { mode: "consult", inflightWaitMs: 30_000, preventRetryWindow: 9 },
      },
    });
    expect(capsule.handoff).toEqual({
      mode: "consult",
      preventRetryWindow: 9,
      canExecuteActions: false,
    });
    expect(capsule.compression.policy).toBe("truncateMiddle");
    const text = renderHandoffCapsuleText(capsule, { maxBytes: 32_000 });
    expect(text).toContain("CONSULT ONLY");
    const message = renderHandoffCapsuleMessage(capsule);
    expect(message.role).toBe("system");
    expect(message.name).toBe("nexus-provider-handoff");
    expect(message.content[0]).toMatchObject({ type: "text" });
    expect(() => renderHandoffCapsuleText(capsule, { maxBytes: 100 })).toThrow(
      HandoffCapsuleBudgetError,
    );
  });

  it("redacts known and detected secrets before signing any safe field", () => {
    const value = input();
    value.workspace.commands[0]!.output =
      "Bearer abc.def.ghi api_key=sk-test_abcdefghijklmnopqrstuvwxyz custom-super-secret";
    value.partialResponse!.text = "password=hunter2 custom-super-secret";
    const serialized = serializeHandoffCapsule(
      createHandoffCapsule(value, {
        createdAt: NOW,
        secrets: ["custom-super-secret"],
      }),
    );
    expect(serialized).not.toContain("abc.def.ghi");
    expect(serialized).not.toContain("sk-test_abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("custom-super-secret");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).toContain("<redacted>");
  });

  it("detects corruption and rejects invalid or unsupported capsules", () => {
    const serialized = serializeHandoffCapsule(createHandoffCapsule(input(), { createdAt: NOW }));
    const corrupt = serialized.replace("Build the handoff capsule", "Hide the handoff capsule");
    expect(() => deserializeHandoffCapsule(corrupt)).toThrow(HandoffCapsuleIntegrityError);

    const invalid = JSON.parse(serialized) as Record<string, unknown>;
    invalid.schema = "nexus.handoff-capsule/v999";
    expect(() => deserializeHandoffCapsule(JSON.stringify(invalid))).toThrow(
      HandoffCapsuleValidationError,
    );
    expect(() =>
      createHandoffCapsule({ ...input(), goal: { ...input().goal, objective: "" } }, { createdAt: NOW }),
    ).toThrow(HandoffCapsuleValidationError);

    const duplicate = input();
    duplicate.tools.outcomes.push({ ...duplicate.tools.outcomes[0]! });
    expect(() => createHandoffCapsule(duplicate, { createdAt: NOW })).toThrow(
      HandoffCapsuleValidationError,
    );
  });

  it("keeps strict validation closed while relaxed validation permits version-safe extensions", () => {
    const capsule = createHandoffCapsule(input(), { createdAt: NOW });
    const extended = { ...capsule, futureMetadata: { safe: true } };
    expect(validateHandoffCapsule(extended).valid).toBe(false);
    expect(
      validateHandoffCapsule(extended, { validationStrictness: "relaxed" }),
    ).toMatchObject({
      valid: true,
      warnings: ["unknown root fields were ignored by relaxed validation"],
    });
  });

  it("semantically removes raw bulk while preserving decisions and enforcing the hard budget", () => {
    const value = input();
    value.workspace.modifiedFiles[0]!.diff = "diff-line\n".repeat(20_000);
    value.workspace.commands[0]!.output = "command-line\n".repeat(20_000);
    value.contextManifest[1]!.content = "source-content\n".repeat(20_000);
    const capsule = createHandoffCapsule(value, {
      createdAt: NOW,
      compressionPolicy: "semantic",
      maxBytes: 16_000,
      maxTokens: 8_000,
    });
    const serialized = serializeHandoffCapsule(capsule);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(16_000);
    expect(capsule.compression.compressed).toBe(true);
    expect(capsule.compression.omissions).toContain("workspace.raw-diffs");
    expect(capsule.decisions[0]!.decision).toBe("Use canonical JSON");
    expect(capsule.workspace.modifiedFiles[0]!.diff).toBeUndefined();
  });

  it("truncateMiddle retains both ends and fails closed when essential state cannot fit", () => {
    const value = input();
    value.workspace.modifiedFiles[0]!.diff = `START-${"x".repeat(30_000)}-END`;
    const capsule = createHandoffCapsule(value, {
      createdAt: NOW,
      compressionPolicy: "truncateMiddle",
      maxBytes: 14_000,
      maxTokens: 8_000,
    });
    const diff = capsule.workspace.modifiedFiles[0]!.diff!;
    expect(diff).toContain("START-");
    expect(diff).toContain("-END");
    expect(diff).toContain("<middle omitted>");

    const impossible = input();
    impossible.goal.objective = "essential ".repeat(20_000);
    expect(() =>
      createHandoffCapsule(impossible, {
        createdAt: NOW,
        maxBytes: 2_000,
        maxTokens: 500,
      }),
    ).toThrow(HandoffCapsuleBudgetError);
  });

  it("blocks duplicate successful, partial, in-flight, and explicit actions for the retry window", () => {
    const value = input();
    value.tools.outcomes.push({
      actionId: "running-1",
      tool: "exec",
      status: "in-progress",
      summary: "still running",
      idempotent: true,
      turn: 7,
    });
    const capsule = createHandoffCapsule(value, {
      createdAt: NOW,
      preventRetryWindow: 3,
    });

    expect(actionRetryDecision(capsule, "write-file-1", 0)).toMatchObject({
      blocked: true,
      reason: "completed-action",
      remainingTurns: 3,
    });
    expect(actionRetryDecision(capsule, "deploy-1", 2).reason).toBe("partial-effect");
    expect(actionRetryDecision(capsule, "running-1", 2).reason).toBe("in-flight");
    expect(actionRetryDecision(capsule, "write-file-1", 3)).toEqual({ blocked: false });
    expect(actionRetryDecision(capsule, "deploy-forever", 100).reason).toBe(
      "explicit-do-not-repeat",
    );
    expect(actionRetryDecision(capsule, "new-action", 0)).toEqual({ blocked: false });
  });
});
