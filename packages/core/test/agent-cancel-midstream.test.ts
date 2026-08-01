/**
 * Mid-stream cancellation of an in-flight `dispatchAgent` run. Cancellation
 * pre-dispatch is already covered (agent.test.ts's "honors ctx.signal");
 * untested seam (audit F3) is cancelling AFTER a run is already streaming —
 * both mid text-delta (orchestrator.ts's per-turn abort check, ~1913-1916)
 * and mid tool-execution (the abort check at the top of the next turn,
 * ~2254-2257, since a tool call itself is not preemptible). Both must settle
 * in exactly one terminal cancelled `AdapterError` chunk and never run a
 * further tool after cancellation — guarded by a test timeout so a
 * regression that hangs fails fast instead of hanging CI.
 */
import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  dispatchAgent,
  type ProviderAdapter,
} from "@nexuscode/core";
import { AdapterError, type ChatRequest, type Message, type StreamChunk } from "@nexuscode/shared";
import { PermissionGate, ToolRegistry, okText, type Tool } from "@nexuscode/tools";
import { createMockAdapter } from "@nexuscode/provider-mock";

/** Poll until `predicate()` is true, or fail after `timeoutMs`. */
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/**
 * A stub adapter (same pattern as `alwaysToolAdapter` below) that streams a
 * text answer in two chunks, pausing between them on an externally-resolved
 * `gate` promise instead of a wall-clock delay — so a caller can deterministically
 * cancel while the adapter is paused mid-stream, with no timing race against the
 * test runner. Re-checks `ctx.signal` after the gate resolves and, if aborted,
 * emits the terminal `cancelled` error chunk itself (mirroring the real mock
 * adapter's `abortableDelay` contract) instead of continuing to stream.
 */
function gatedTextAdapter(gate: Promise<void>): ProviderAdapter {
  const base = createMockAdapter({ id: "gated" });
  return {
    ...base,
    stream(req: ChatRequest, ctx): AsyncIterable<StreamChunk> {
      return (async function* (): AsyncIterable<StreamChunk> {
        yield { type: "run-start", runId: ctx.runId, adapterId: "gated", model: req.model, ts: Date.now() };
        yield { type: "text-delta", runId: ctx.runId, text: "first ", channel: "answer" };
        await gate;
        if (ctx.signal.aborted) {
          yield {
            type: "error",
            runId: ctx.runId,
            error: new AdapterError("cancelled", "Gated mock run cancelled by caller.", {
              providerId: "gated",
              retryable: false,
            }),
            retryable: false,
          };
          return;
        }
        yield { type: "text-delta", runId: ctx.runId, text: "second", channel: "answer" };
        const message: Message = { role: "assistant", content: [{ type: "text", text: "first second" }] };
        yield { type: "run-end", runId: ctx.runId, finishReason: "stop", message, ts: Date.now() };
      })();
    },
  };
}

/**
 * A stub adapter (same pattern as reliability-integration.test.ts's
 * `exhausted`/`backup`: a real mock adapter with `stream` overridden) that
 * unconditionally answers every turn with a tool call for `toolName` —
 * regardless of whether the request even offered tools. Used to prove the
 * loop never issues a SECOND tool call once cancellation lands.
 */
function alwaysToolAdapter(toolName: string): ProviderAdapter {
  const base = createMockAdapter({ id: "loopy", models: ["loopy-tools"] });
  let n = 0;
  return {
    ...base,
    stream(req: ChatRequest, ctx): AsyncIterable<StreamChunk> {
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

describe("dispatchAgent — mid-stream cancellation", () => {
  it(
    "cancelling while a multi-chunk text stream is gated mid-stream yields exactly one terminal cancelled AdapterError chunk and settles the outcome",
    async () => {
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });

      const registry = new ProviderRegistry();
      await registry.register(gatedTextAdapter(gate));
      const engine = createEngine({ registry });
      const session = await engine.openSession();
      const turn = session.newTurn({ prompt: "PING PONG PANG" });
      const runCtx = turn.context();
      const tools = new ToolRegistry();

      const handle = dispatchAgent(
        { adapterId: "gated", model: "mock-fast", input: turn.input, idempotencyKey: "cancel-mid-text" },
        runCtx,
        { tools, gate: new PermissionGate({ mode: "full-access" }) },
      );

      const iterator = handle.events()[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(first.value?.chunk.type).toBe("run-start");

      const second = await iterator.next();
      expect(second.done).toBe(false);
      expect(second.value?.chunk.type).toBe("text-delta");

      // The adapter is now blocked on `gate`, mid-stream. Cancel while gated,
      // then release — no wall-clock pacing is involved anywhere here.
      await runCtx.scope.cancel("user");
      releaseGate();

      const rest: StreamChunk[] = [];
      for (let r = await iterator.next(); !r.done; r = await iterator.next()) {
        rest.push(r.value.chunk);
      }

      const errors = rest.filter((c) => c.type === "error");
      expect(errors).toHaveLength(1);
      const err = errors[0];
      if (err?.type !== "error") throw new Error("expected error chunk");
      expect(err.error.code).toBe("cancelled");
      // The cancelled error is the terminal chunk — nothing follows it.
      expect(rest.at(-1)).toBe(err);
      // No tool was ever in play on this run at all.
      expect(rest.some((c) => c.type === "tool-call-start" || c.type === "tool-result")).toBe(false);

      const outcome = await handle.outcome();
      expect(outcome.winner?.status).toBe("cancelled");

      await engine.dispose();
    },
    5_000,
  );

  it(
    "cancelling while a tool call is executing stops the loop before any further tool executes",
    async () => {
      let toolRunCount = 0;
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      const slowTool: Tool = {
        name: "slow",
        description: "awaits an externally-controlled gate before completing",
        permission: "read",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        async run() {
          toolRunCount += 1;
          await gate;
          return okText("finished");
        },
      };

      const registry = new ProviderRegistry();
      await registry.register(alwaysToolAdapter("slow"));
      const engine = createEngine({ registry });
      const session = await engine.openSession();
      const turn = session.newTurn({ prompt: "GO" });
      const runCtx = turn.context();
      const tools = new ToolRegistry();
      tools.register(slowTool);

      const handle = dispatchAgent(
        { adapterId: "loopy", model: "loopy-tools", input: turn.input, idempotencyKey: "cancel-mid-tool" },
        runCtx,
        { tools, gate: new PermissionGate({ mode: "full-access" }) },
      );

      // Let the pump run ahead until the tool is actually mid-execution
      // (blocked on `gate`), THEN cancel, THEN let the tool finish.
      await waitFor(() => toolRunCount === 1);
      await runCtx.scope.cancel("user");
      releaseGate();

      const chunks: StreamChunk[] = [];
      for await (const e of handle.events()) chunks.push(e.chunk);
      const outcome = await handle.outcome();

      // The in-flight tool call was allowed to finish (it is not
      // preemptible), but the loop never started a second one.
      expect(toolRunCount).toBe(1);

      const errors = chunks.filter((c) => c.type === "error");
      expect(errors).toHaveLength(1);
      const err = errors[0];
      if (err?.type !== "error") throw new Error("expected error chunk");
      expect(err.error.code).toBe("cancelled");
      expect(chunks.at(-1)).toBe(err);

      expect(outcome.winner?.status).toBe("cancelled");

      await engine.dispose();
    },
    5_000,
  );
});
