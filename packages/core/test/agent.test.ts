import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  dispatchAgent,
  type ContextAssembler,
  type Engine,
  type Labeled,
  type RunContext,
} from "@nexuscode/core";
import type { Message, StreamChunk } from "@nexuscode/shared";
import {
  PermissionGate,
  ToolRegistry,
  okText,
  type PermissionMode,
  type Tool,
} from "@nexuscode/tools";
import { createMockAdapter } from "@nexuscode/provider-mock";

/** A trivial, offline read-class tool that echoes its input. */
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

/** A write-class tool (used to exercise permission denial under read-only). */
function dangerTool(): Tool {
  return {
    name: "danger",
    description: "A write-class tool that should be gated.",
    permission: "write",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    async run() {
      return okText("danger executed");
    },
  };
}

interface Harness {
  engine: Engine;
  runCtx: RunContext;
  input: Message[];
}

async function setup(opts: {
  toolName: string;
  contextAssembler?: ContextAssembler;
  prompt?: string;
}): Promise<Harness> {
  const registry = new ProviderRegistry();
  await registry.register(
    createMockAdapter({ toolName: opts.toolName, toolInput: (p) => ({ text: p }) }),
  );
  const engine = createEngine(
    opts.contextAssembler
      ? { registry, contextAssembler: opts.contextAssembler }
      : { registry },
  );
  const session = await engine.openSession();
  const turn = session.newTurn({ prompt: opts.prompt ?? "PING" });
  return { engine, runCtx: turn.context(), input: turn.input };
}

async function drain(events: AsyncIterable<Labeled<StreamChunk>>): Promise<Labeled<StreamChunk>[]> {
  const out: Labeled<StreamChunk>[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function gate(mode: PermissionMode): PermissionGate {
  return new PermissionGate({ mode });
}

describe("dispatchAgent — native tool-execution loop", () => {
  it("executes the tool, feeds the result back, and re-invokes to a final answer", async () => {
    const { engine, runCtx, input } = await setup({ toolName: "echo", prompt: "PING" });
    const tools = new ToolRegistry();
    tools.register(echoTool());

    const handle = dispatchAgent(
      { adapterId: "mock", model: "mock-tools", input, idempotencyKey: "a1" },
      runCtx,
      { tools, gate: gate("full-access") },
    );

    const events = await drain(handle.events());
    const outcome = await handle.outcome();
    const chunks = events.map((e) => e.chunk);

    // The tool was actually invoked (native tool-call in the stream).
    expect(chunks.some((c) => c.type === "tool-call-end")).toBe(true);
    expect(outcome.winner?.toolCalls.map((t) => t.name)).toEqual(["echo"]);

    // The tool RESULT was fed back onto the stream as a tool-result chunk...
    const toolResults = chunks.filter((c) => c.type === "tool-result");
    expect(toolResults).toHaveLength(1);
    const tr = toolResults[0];
    if (tr?.type !== "tool-result") throw new Error("expected tool-result");
    expect(tr.isError).not.toBe(true);

    // ...and the provider was re-invoked, producing a final answer that
    // references the tool result — proving the loop closed.
    expect(outcome.winner?.status).toBe("ok");
    expect(outcome.winner?.finishReason).toBe("stop");
    expect(outcome.winner?.text).toContain("echoed: PING");

    // Frozen-contract invariant preserved across the multi-turn run: exactly one
    // run-start first and exactly one terminal run-end last.
    expect(chunks.filter((c) => c.type === "run-start")).toHaveLength(1);
    expect(chunks.filter((c) => c.type === "run-end")).toHaveLength(1);
    expect(chunks[0]?.type).toBe("run-start");
    expect(chunks[chunks.length - 1]?.type).toBe("run-end");

    await engine.dispose();
  });

  it("aggregates token usage across every provider turn (no undercount)", async () => {
    // The mock tool-model runs two provider turns: turn 1 emits the tool call
    // (usage inputTokens = estimateTokens("PING") = 1), turn 2 emits the final
    // answer (usage inputTokens = estimateTokens("echoed: PING") = 3). The run
    // total MUST be their sum (4), not just the last turn's 3.
    const { engine, runCtx, input } = await setup({ toolName: "echo", prompt: "PING" });
    const tools = new ToolRegistry();
    tools.register(echoTool());

    const handle = dispatchAgent(
      { adapterId: "mock", model: "mock-tools", input, idempotencyKey: "usage1" },
      runCtx,
      { tools, gate: gate("full-access") },
    );

    const events = await drain(handle.events());
    const outcome = await handle.outcome();
    const chunks = events.map((e) => e.chunk);

    // Both turns are counted: 1 (tool turn) + 3 (answer turn) = 4 input tokens.
    expect(outcome.winner?.usage.inputTokens).toBe(4);
    // The output tokens likewise exceed a single turn's contribution.
    expect(outcome.winner?.usage.outputTokens).toBeGreaterThan(4);

    // Exactly one aggregated usage chunk reaches consumers, and the terminal
    // run-end carries the same total.
    const usageChunks = chunks.filter((c) => c.type === "usage");
    expect(usageChunks).toHaveLength(1);
    const runEnd = chunks.find((c) => c.type === "run-end");
    if (runEnd?.type !== "run-end") throw new Error("expected run-end");
    expect(runEnd.usage?.inputTokens).toBe(4);

    await engine.dispose();
  });

  it("denies a write-class tool under read-only and still closes the loop", async () => {
    const { engine, runCtx, input } = await setup({ toolName: "danger", prompt: "GO" });
    const tools = new ToolRegistry();
    tools.register(dangerTool());

    const handle = dispatchAgent(
      { adapterId: "mock", model: "mock-tools", input, idempotencyKey: "a2" },
      runCtx,
      { tools, gate: gate("read-only") },
    );

    const events = await drain(handle.events());
    const outcome = await handle.outcome();
    const chunks = events.map((e) => e.chunk);

    // The tool-result is an ERROR (permission denied), not an execution.
    const tr = chunks.find((c) => c.type === "tool-result");
    if (tr?.type !== "tool-result") throw new Error("expected tool-result");
    expect(tr.isError).toBe(true);

    // Even so, the run settles cleanly with a terminal run-end.
    expect(outcome.winner?.status).toBe("ok");
    expect(chunks.filter((c) => c.type === "run-end")).toHaveLength(1);

    await engine.dispose();
  });

  it("runs the injected Context Engine before dispatch (context assembly used in a run)", async () => {
    let called = 0;
    let sawUserText = "";
    const assembler: ContextAssembler = {
      async assemble(inputArg) {
        called += 1;
        for (const m of inputArg.messages) {
          for (const b of m.content) if (b.type === "text") sawUserText += b.text;
        }
        return { messages: [{ role: "user", content: [{ type: "text", text: "ASSEMBLED_MARKER" }] }] };
      },
    };

    // A tool-less model + empty registry exercises the single-turn agent path,
    // isolating the context-assembly step.
    const { engine, runCtx, input } = await setup({
      toolName: "echo",
      contextAssembler: assembler,
      prompt: "ORIGINAL",
    });
    const tools = new ToolRegistry();

    const handle = dispatchAgent(
      { adapterId: "mock", model: "mock-fast", input, idempotencyKey: "a3" },
      runCtx,
      { tools, gate: gate("read-only") },
    );

    await drain(handle.events());
    const outcome = await handle.outcome();

    expect(called).toBe(1);
    expect(sawUserText).toContain("ORIGINAL");
    // The assembled message (not the raw prompt) reached the provider.
    expect(outcome.winner?.text).toContain("ASSEMBLED_MARKER");
    expect(outcome.winner?.text).not.toContain("ORIGINAL");

    await engine.dispose();
  });

  it("honors ctx.signal: a pre-cancelled scope yields a terminal cancelled error", async () => {
    const { engine, runCtx, input } = await setup({ toolName: "echo", prompt: "PING" });
    const tools = new ToolRegistry();
    tools.register(echoTool());

    await runCtx.scope.cancel("user");

    const handle = dispatchAgent(
      { adapterId: "mock", model: "mock-tools", input, idempotencyKey: "a4" },
      runCtx,
      { tools, gate: gate("full-access") },
    );

    const events = await drain(handle.events());
    const outcome = await handle.outcome();
    const last = events[events.length - 1]?.chunk;

    expect(last?.type).toBe("error");
    if (last?.type !== "error") throw new Error("expected terminal error");
    expect(last.error.code).toBe("cancelled");
    expect(outcome.winner?.status).toBe("cancelled");

    await engine.dispose();
  });
});
