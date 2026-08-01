/**
 * The final-permitted-turn tool drop (orchestrator.ts's `agentStream`,
 * ~1929-1937): on the LAST turn `maxTurns` allows, the loop withholds
 * `req.tools`/`req.toolChoice` so the model is forced to answer in text
 * instead of requesting yet another tool, then synthesizes a clean
 * `"[agent] max turns reached"` terminal if the model asks for a tool
 * anyway (audit F8, untested). A recording stub adapter that ALWAYS answers
 * with a tool call — even when the request offers none — proves both the
 * request-shape change and the forced terminal.
 */
import { describe, it, expect } from "vitest";
import { ProviderRegistry, createEngine, dispatchAgent, type ProviderAdapter } from "@nexuscode/core";
import type { ChatRequest, Message, StreamChunk } from "@nexuscode/shared";
import { PermissionGate, ToolRegistry, okText, type Tool } from "@nexuscode/tools";
import { createMockAdapter } from "@nexuscode/provider-mock";

/** Same stub-adapter pattern as reliability-integration.test.ts: a real mock
 * adapter with `stream` overridden. Records every `ChatRequest` it receives
 * and always answers with a tool call, whether or not tools were offered. */
function alwaysToolAdapter(toolName: string, requests: ChatRequest[]): ProviderAdapter {
  const base = createMockAdapter({ id: "loopy", models: ["loopy-tools"] });
  let n = 0;
  return {
    ...base,
    stream(req: ChatRequest, ctx): AsyncIterable<StreamChunk> {
      requests.push(structuredClone(req));
      n += 1;
      const id = `call_${n}`;
      return (async function* (): AsyncIterable<StreamChunk> {
        yield { type: "run-start", runId: ctx.runId, adapterId: "loopy", model: req.model, ts: Date.now() };
        yield { type: "tool-call-start", runId: ctx.runId, id, name: toolName };
        yield { type: "tool-call-end", runId: ctx.runId, id, input: {} };
        const message: Message = {
          role: "assistant",
          content: [{ type: "tool_use", id, name: toolName, input: {} }],
        };
        yield { type: "run-end", runId: ctx.runId, finishReason: "tool_use", message, ts: Date.now() };
      })();
    },
  };
}

function alwaysTool(name: string): Tool {
  return {
    name,
    description: "always available, always succeeds",
    permission: "read",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    async run() {
      return okText("did it");
    },
  };
}

describe("dispatchAgent — last-turn tool drop", () => {
  it("drops tools/toolChoice on the final permitted turn and forces a synthesized text terminal", async () => {
    const requests: ChatRequest[] = [];
    const registry = new ProviderRegistry();
    await registry.register(alwaysToolAdapter("loop", requests));
    const engine = createEngine({ registry });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "keep going forever" });
    const tools = new ToolRegistry();
    tools.register(alwaysTool("loop"));

    const handle = dispatchAgent(
      { adapterId: "loopy", model: "loopy-tools", input: turn.input, idempotencyKey: "last-turn-drop" },
      turn.context(),
      { tools, gate: new PermissionGate({ mode: "full-access" }), maxTurns: 2 },
    );

    const chunks: StreamChunk[] = [];
    for await (const e of handle.events()) chunks.push(e.chunk);
    const outcome = await handle.outcome();

    // Every turn the model was invoked (both of them, maxTurns=2).
    expect(requests).toHaveLength(2);

    // Turn 0 (not the last) offers tools normally.
    expect(requests[0]?.tools?.length).toBeGreaterThan(0);
    expect(requests[0]?.toolChoice).toBe("auto");

    // Turn 1 IS the last permitted turn: tools/toolChoice are withheld so the
    // model has no way to ask for another tool call.
    expect(requests[1]?.tools).toBeUndefined();
    expect(requests[1]?.toolChoice).toBeUndefined();

    // The stub still (mis)behaves and answers with a tool call anyway — the
    // loop must not hang or crash on that; it forces its own text terminal.
    // (This synthesized reply is never streamed as `text-delta` chunks, so
    // `RunResult.text` — which only accumulates those — stays empty; the
    // forced answer lives on the terminal `run-end.message` instead.)
    expect(outcome.winner?.finishReason).toBe("length");
    const runEnd = chunks.find((c) => c.type === "run-end");
    if (runEnd?.type !== "run-end") throw new Error("expected run-end");
    expect(runEnd.message).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "[agent] max turns reached" }],
    });

    await engine.dispose();
  });
});
