/**
 * `ctx.actionGuard` — the harness-owned duplicate-effect gate `executeToolCall`
 * enforces before the ordinary permission gate (orchestrator.ts §"native
 * tool-execution loop"). Untested seam (audit F1): a `blocked` verdict's exact
 * error text, the fail-closed-for-write/fail-open-for-read asymmetry when the
 * guard itself throws, and the `permissionFor`-throws fallback that decides
 * which permission class the guard is even told about.
 */
import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  dispatchAgent,
  type Labeled,
  type ProviderActionGuardInput,
} from "@nexuscode/core";
import type { StreamChunk } from "@nexuscode/shared";
import { PermissionGate, ToolRegistry, okText, type Tool } from "@nexuscode/tools";
import { createMockAdapter } from "@nexuscode/provider-mock";

async function drain(events: AsyncIterable<Labeled<StreamChunk>>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const e of events) out.push(e.chunk);
  return out;
}

function textOf(chunk: StreamChunk | undefined): string {
  if (!chunk || chunk.type !== "tool-result") throw new Error("expected tool-result");
  const block = chunk.content[0];
  if (!block || block.type !== "text") throw new Error("expected text content");
  return block.text;
}

/** Run one tool call through a fresh engine/registry with the given guard. */
async function runWithGuard(opts: {
  tool: Tool;
  guard: (input: ProviderActionGuardInput) => { blocked: boolean; reason?: string } | Promise<{ blocked: boolean; reason?: string }>;
}): Promise<{ chunks: StreamChunk[]; status: string | undefined }> {
  const registry = new ProviderRegistry();
  await registry.register(createMockAdapter({ toolName: opts.tool.name, toolInput: () => ({}) }));
  const engine = createEngine({ registry, actionGuard: opts.guard });
  const session = await engine.openSession();
  const turn = session.newTurn({ prompt: "GO" });
  const tools = new ToolRegistry();
  tools.register(opts.tool);

  const handle = dispatchAgent(
    { adapterId: "mock", model: "mock-tools", input: turn.input, idempotencyKey: `guard-${opts.tool.name}` },
    turn.context(),
    { tools, gate: new PermissionGate({ mode: "full-access" }) },
  );
  const chunks = await drain(handle.events());
  const outcome = await handle.outcome();
  await engine.dispose();
  return { chunks, status: outcome.winner?.status };
}

function readTool(name = "peek"): Tool {
  return {
    name,
    description: "A read-class tool.",
    permission: "read",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    async run() {
      return okText("peeked");
    },
  };
}

function writeTool(name = "mutate"): Tool {
  return {
    name,
    description: "A write-class tool.",
    permission: "write",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    async run() {
      return okText("mutated");
    },
  };
}

describe("actionGuard — blocked verdict", () => {
  it("a blocked verdict produces the documented error text and the loop continues to a final answer", async () => {
    const { chunks, status } = await runWithGuard({
      tool: readTool("echo"),
      guard: () => ({ blocked: true, reason: "duplicate effect" }),
    });

    const toolResults = chunks.filter((c) => c.type === "tool-result");
    expect(toolResults).toHaveLength(1);
    const tr = toolResults[0];
    if (tr?.type !== "tool-result") throw new Error("expected tool-result");
    expect(tr.isError).toBe(true);
    expect(textOf(tr)).toBe("tool echo blocked by provider handoff guard: duplicate effect");

    // The blocked result is fed back like any other tool result — the run
    // still closes with exactly one terminal run-end, not a crash/hang.
    expect(chunks.filter((c) => c.type === "run-end")).toHaveLength(1);
    expect(status).toBe("ok");
  });

  it("a blocked verdict with no reason omits the trailing colon", async () => {
    const { chunks } = await runWithGuard({
      tool: readTool("echo"),
      guard: () => ({ blocked: true }),
    });
    const tr = chunks.find((c) => c.type === "tool-result");
    expect(textOf(tr)).toBe("tool echo blocked by provider handoff guard");
  });
});

describe("actionGuard — a throwing guard fails closed for write, fails open for read", () => {
  it("blocks a write-permission tool when the guard throws", async () => {
    const { chunks } = await runWithGuard({
      tool: writeTool("mutate"),
      guard: () => {
        throw new Error("guard exploded");
      },
    });
    const tr = chunks.find((c) => c.type === "tool-result");
    if (tr?.type !== "tool-result") throw new Error("expected tool-result");
    expect(tr.isError).toBe(true);
    expect(textOf(tr)).toBe("tool mutate blocked because the handoff guard failed");
  });

  it("allows a read-permission tool through when the guard throws (deliberate current fail-open-for-read behavior, see orchestrator.ts executeToolCall catch)", async () => {
    const { chunks } = await runWithGuard({
      tool: readTool("peek"),
      guard: () => {
        throw new Error("guard exploded");
      },
    });
    const tr = chunks.find((c) => c.type === "tool-result");
    if (tr?.type !== "tool-result") throw new Error("expected tool-result");
    expect(tr.isError).not.toBe(true);
    expect(textOf(tr)).toBe("peeked");
  });
});

describe("actionGuard — permissionFor fallback", () => {
  it("a throwing permissionFor falls back to the tool's static permission for the guard call", async () => {
    const seen: string[] = [];
    const tool: Tool = {
      name: "quirky",
      description: "read-class statically, but its dynamic classifier is broken.",
      permission: "read",
      parameters: { type: "object", properties: {}, additionalProperties: true },
      permissionFor() {
        throw new Error("cannot classify this input");
      },
      async run() {
        return okText("ok");
      },
    };
    await runWithGuard({
      tool,
      guard: (input) => {
        seen.push(input.permission);
        return { blocked: false };
      },
    });
    expect(seen).toEqual(["read"]);
  });
});
