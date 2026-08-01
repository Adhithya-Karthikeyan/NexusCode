/**
 * `AgentOptions.toolInterceptor` — the additive, hook-agnostic pre/post-tool
 * seam (§24 hooks) `executeToolCall` wraps around every tool call
 * (orchestrator.ts ~1578-1637 for the types, ~1697-1714/1763-1774 for
 * enforcement). Untested seam (audit F2): a `preTool` input rewrite actually
 * reaches the tool, a throwing interceptor of either kind is fully swallowed,
 * and `postTool` observes the right `{ok, output}` shape for both a
 * successful and a failing tool result. `block: true` veto is covered
 * elsewhere and intentionally skipped here.
 */
import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  dispatchAgent,
  type Labeled,
} from "@nexuscode/core";
import type { StreamChunk } from "@nexuscode/shared";
import { PermissionGate, ToolRegistry, okText, errText, type Tool } from "@nexuscode/tools";
import { createMockAdapter } from "@nexuscode/provider-mock";

async function drain(events: AsyncIterable<Labeled<StreamChunk>>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const e of events) out.push(e.chunk);
  return out;
}

/** A tool that records the exact input it was invoked with. */
function recordingTool(name: string, calls: unknown[]): Tool {
  return {
    name,
    description: "records its input, echoes it back",
    permission: "read",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    async run(input) {
      calls.push(input);
      return okText(`ran with ${JSON.stringify(input)}`);
    },
  };
}

function failingTool(name: string): Tool {
  return {
    name,
    description: "always fails",
    permission: "read",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    async run() {
      return errText("nope");
    },
  };
}

describe("toolInterceptor.preTool — input rewrite", () => {
  it("a preTool rewrite reaches the tool's actual invocation", async () => {
    const calls: unknown[] = [];
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ toolName: "echo", toolInput: (p) => ({ text: p }) }));
    const engine = createEngine({ registry });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "ORIGINAL" });
    const tools = new ToolRegistry();
    tools.register(recordingTool("echo", calls));

    const handle = dispatchAgent(
      { adapterId: "mock", model: "mock-tools", input: turn.input, idempotencyKey: "pretool-rewrite" },
      turn.context(),
      {
        tools,
        gate: new PermissionGate({ mode: "full-access" }),
        toolInterceptor: {
          preTool: () => ({ input: { text: "REWRITTEN" } }),
        },
      },
    );
    await drain(handle.events());

    expect(calls).toEqual([{ text: "REWRITTEN" }]);
    await engine.dispose();
  });
});

describe("toolInterceptor — a throwing interceptor is fully swallowed", () => {
  it("a throwing preTool and postTool neither block nor crash the run", async () => {
    const calls: unknown[] = [];
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ toolName: "echo", toolInput: (p) => ({ text: p }) }));
    const engine = createEngine({ registry });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "PING" });
    const tools = new ToolRegistry();
    tools.register(recordingTool("echo", calls));

    const handle = dispatchAgent(
      { adapterId: "mock", model: "mock-tools", input: turn.input, idempotencyKey: "pretool-throw" },
      turn.context(),
      {
        tools,
        gate: new PermissionGate({ mode: "full-access" }),
        toolInterceptor: {
          preTool: () => {
            throw new Error("preTool exploded");
          },
          postTool: () => {
            throw new Error("postTool exploded");
          },
        },
      },
    );
    const chunks = await drain(handle.events());
    const outcome = await handle.outcome();

    // Neither blocked (tool ran with its original, un-rewritten input)...
    expect(calls).toEqual([{ text: "PING" }]);
    const tr = chunks.find((c) => c.type === "tool-result");
    if (tr?.type !== "tool-result") throw new Error("expected tool-result");
    expect(tr.isError).not.toBe(true);
    // ...nor crashed the run.
    expect(chunks.filter((c) => c.type === "run-end")).toHaveLength(1);
    expect(outcome.winner?.status).toBe("ok");

    await engine.dispose();
  });
});

describe("toolInterceptor.postTool — observes the real outcome shape", () => {
  it("sees ok:true and the real output content for a successful tool call", async () => {
    const observed: Array<{ name: string; ok: boolean; output: unknown }> = [];
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ toolName: "echo", toolInput: (p) => ({ text: p }) }));
    const engine = createEngine({ registry });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "PING" });
    const tools = new ToolRegistry();
    tools.register(recordingTool("echo", []));

    const handle = dispatchAgent(
      { adapterId: "mock", model: "mock-tools", input: turn.input, idempotencyKey: "posttool-ok" },
      turn.context(),
      {
        tools,
        gate: new PermissionGate({ mode: "full-access" }),
        toolInterceptor: { postTool: (res) => void observed.push(res) },
      },
    );
    await drain(handle.events());

    expect(observed).toEqual([
      { name: "echo", ok: true, output: [{ type: "text", text: 'ran with {"text":"PING"}' }] },
    ]);
    await engine.dispose();
  });

  it("sees ok:false and the error content for a failing tool call", async () => {
    const observed: Array<{ name: string; ok: boolean; output: unknown }> = [];
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ toolName: "boom", toolInput: () => ({}) }));
    const engine = createEngine({ registry });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "GO" });
    const tools = new ToolRegistry();
    tools.register(failingTool("boom"));

    const handle = dispatchAgent(
      { adapterId: "mock", model: "mock-tools", input: turn.input, idempotencyKey: "posttool-err" },
      turn.context(),
      {
        tools,
        gate: new PermissionGate({ mode: "full-access" }),
        toolInterceptor: { postTool: (res) => void observed.push(res) },
      },
    );
    await drain(handle.events());

    expect(observed).toEqual([
      { name: "boom", ok: false, output: [{ type: "text", text: "nope" }] },
    ]);
    await engine.dispose();
  });
});
