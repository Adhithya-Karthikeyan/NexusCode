import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  dispatchAgent,
  type TransferHandle,
} from "@nexuscode/core";
import type { StreamChunk } from "@nexuscode/shared";
import { PermissionGate, ToolRegistry, okText, type Tool } from "@nexuscode/tools";
import { createMockAdapter } from "@nexuscode/provider-mock";

/** A trivial read-class echo tool. */
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
      return okText(`echoed: ${(input as { text?: string }).text ?? ""}`);
    },
  };
}

async function drain(events: AsyncIterable<{ chunk: StreamChunk }>): Promise<void> {
  for await (const _e of events) {
    /* drain */
  }
}

describe("dispatchAgent — ZLCTS transfer seam", () => {
  it("routes every chunk + tool output + turn boundary to ctx.transfer without breaking the loop", async () => {
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ toolName: "echo", toolInput: (p) => ({ text: p }) }));
    const engine = createEngine({ registry });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "PING" });
    const runCtx = turn.context();

    const seen = {
      verbatim: 0,
      project: 0,
      toolOutput: [] as string[],
      turnStart: 0,
      turnEnd: 0,
      chunks: [] as StreamChunk[],
    };
    const spy: TransferHandle = {
      sessionId: runCtx.sessionId,
      captureVerbatim: (c) => {
        seen.verbatim++;
        seen.chunks.push(c);
      },
      project: async () => {
        seen.project++;
      },
      recordToolOutput: (tool) => {
        seen.toolOutput.push(tool);
      },
      turnBoundary: async (kind) => {
        if (kind === "start") seen.turnStart++;
        else seen.turnEnd++;
      },
      flush: () => {},
    };
    runCtx.transfer = spy;

    const tools = new ToolRegistry();
    tools.register(echoTool());
    const handle = dispatchAgent(
      { adapterId: "mock", model: "mock-tools", input: turn.input, idempotencyKey: "tx1" },
      runCtx,
      { tools, gate: new PermissionGate({ mode: "full-access" }) },
    );
    await drain(handle.events());
    const outcome = await handle.outcome();

    // The run still completes normally — the transfer seam is non-fatal.
    expect(outcome.winner?.status).toBe("ok");
    expect(outcome.winner?.text).toContain("echoed: PING");

    // Every emitted chunk was captured verbatim AND projected (including the
    // runner-synthesized tool-result, which is NOT an adapter chunk).
    expect(seen.verbatim).toBeGreaterThan(0);
    expect(seen.project).toBe(seen.verbatim);
    expect(seen.chunks.some((c) => c.type === "tool-result")).toBe(true);

    // The tool call was recorded for mid-call-termination resume.
    expect(seen.toolOutput).toContain("echo");

    // Both provider turns got a start boundary; the terminal turn got an end.
    expect(seen.turnStart).toBe(2);
    expect(seen.turnEnd).toBeGreaterThanOrEqual(1);

    // Frozen contract still holds: one run-start first, one run-end last.
    expect(seen.chunks[0]?.type).toBe("run-start");
    expect(seen.chunks[seen.chunks.length - 1]?.type).toBe("run-end");

    await engine.dispose();
  });

  it("runs unchanged when ctx.transfer is undefined (no handle attached)", async () => {
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ toolName: "echo", toolInput: (p) => ({ text: p }) }));
    const engine = createEngine({ registry });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "PING" });
    const runCtx = turn.context();
    // No transfer handle set — runner must behave exactly as before.
    const tools = new ToolRegistry();
    tools.register(echoTool());
    const handle = dispatchAgent(
      { adapterId: "mock", model: "mock-tools", input: turn.input, idempotencyKey: "tx2" },
      runCtx,
      { tools, gate: new PermissionGate({ mode: "full-access" }) },
    );
    await drain(handle.events());
    const outcome = await handle.outcome();
    expect(outcome.winner?.status).toBe("ok");
    expect(outcome.winner?.text).toContain("echoed: PING");
    await engine.dispose();
  });
});