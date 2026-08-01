/**
 * Regression test for the delegation-path unhandled-rejection bug:
 * `Agent.run()` (runner.ts) eagerly builds a `resultPromise` and rejects it
 * from `pump().catch(...)`, but the delegate site
 * (`for await (const l of subHandle.events()) yield l.chunk;` followed by
 * `await subHandle.result();`) never reaches `subHandle.result()` when the
 * `events()` loop itself throws — which is exactly what happens once a
 * failed sub-agent's queue starts rejecting. Left unguarded, that leaves the
 * sub-agent's (and, by the same mechanism one level up, the delegating
 * parent's own) `resultPromise` rejected with no attached handler: an
 * `unhandledRejection` that crashes the process under Node's default
 * handling.
 *
 * `Agent.run()` now attaches a no-op `.catch()` to `resultPromise` right
 * after creating it, so the rejection stays fully observable via
 * `result()` for any caller that DOES await it, while never becoming an
 * unhandled rejection for a caller (like the delegation site) that only
 * ever consumes `events()`.
 */
import { describe, it, expect } from "vitest";
import { ProviderRegistry, createEngine, type RunContext } from "@nexuscode/core";
import { PermissionGate, ToolRegistry, okText, type Tool } from "@nexuscode/tools";
import { TaskStore, type Task, type TaskInput } from "@nexuscode/tasks";
import { createMockAdapter } from "@nexuscode/provider-mock";
import {
  Agent,
  createAgentRegistry,
  type AgentDefinition,
  type AgentDeps,
  type EvaluateFn,
  type Reflection,
} from "../src/index.js";

/** A read-class tool that echoes `{ text }` back. */
function echoTool(): Tool {
  return {
    name: "echo",
    description: "Echo the given text back.",
    permission: "read",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    async run(input) {
      const text = (input as { text?: string }).text ?? "";
      return okText(`echoed: ${text}`);
    },
  };
}

/**
 * A `TaskStore` whose `create()` throws once it has been called
 * `throwOnCreate` times, simulating a plan-store fault deep inside a run's
 * PLAN phase — a throw site that is entirely synchronous (no intervening
 * provider/tool dispatch handle with its own promise plumbing), so the only
 * unhandled-rejection surface it can exercise is `Agent.run()`'s own.
 */
class ThrowAfterNCreates extends TaskStore {
  private creates = 0;
  constructor(private readonly throwOnCreate: number) {
    super({ file: ":memory:" });
  }
  override create(input: TaskInput): Task {
    this.creates += 1;
    if (this.creates >= this.throwOnCreate) {
      throw new Error(`store exploded on create #${this.creates}`);
    }
    return super.create(input);
  }
}

describe("Agent.run — unhandled rejection safety on the delegation path", () => {
  it("a delegated sub-agent whose loop throws does not crash the process, and the error still surfaces from events()", async () => {
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ toolName: "echo", toolInput: (p) => ({ text: p }) }));
    const engine = createEngine({ registry });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "PING" });
    const ctx: RunContext = turn.context();

    // The 1st create() call is the parent's own root task (succeeds); the
    // 2nd is the delegated child's root task (throws) — so the parent
    // completes its PLAN phase normally and only the child's loop faults.
    const store = new ThrowAfterNCreates(2);
    const tools = new ToolRegistry();
    tools.register(echoTool());

    const deps: AgentDeps = {
      tools,
      gate: new PermissionGate({ mode: "full-access" }),
      store,
      defaultModel: "mock-tools",
      defaultAdapterId: "mock",
      registry: createAgentRegistry(),
    };
    const agent = new Agent(deps);

    const childDef: AgentDefinition = {
      role: "child",
      systemPrompt: "You are the delegated child.",
      allowedTools: ["echo"],
      maxSteps: 3,
      permissionMode: "full-access",
    };

    // Unconditionally delegates to `childDef` after the parent's first step,
    // regardless of that step's outcome.
    const alwaysDelegate: EvaluateFn = (): Reflection => ({
      critique: "delegating for the regression test",
      progress: 0,
      goalMet: false,
      verdict: "unmet",
      failure: false,
      needsReplan: false,
      retry: false,
      delegate: { role: childDef, goal: { objective: "child work" } },
    });

    const parentDef: AgentDefinition = {
      role: "parent",
      systemPrompt: "You are the parent.",
      allowedTools: ["echo"],
      maxSteps: 1,
      permissionMode: "full-access",
    };

    const seenUnhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => {
      seenUnhandled.push(err);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      const handle = agent.run(ctx, parentDef, {
        goal: { objective: "parent work" },
        policies: { evaluate: alwaysDelegate },
      });

      // Deliberately consume ONLY events() — never call handle.result() —
      // mirroring the delegation site's own consumption pattern, which is
      // exactly the shape that leaves a rejected resultPromise unobserved.
      const drainEvents = async (): Promise<void> => {
        for await (const _l of handle.events()) void _l;
      };

      // The error still surfaces from the events() iteration itself.
      await expect(drainEvents()).rejects.toThrow(/store exploded/);

      // Give any stray unhandledRejection a full turn of the event loop to
      // surface before asserting it never did.
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }

    expect(seenUnhandled).toEqual([]);

    await engine.dispose();
  });
});
