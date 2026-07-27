/**
 * Hardening added on top of `RunResult.toolExchange` (see `agent.test.ts` for
 * the base feature): every `toolExchange`, from every producer, is guaranteed
 * to have no unpaired `tool_use` block and no oversized tool result by the
 * time it reaches a caller that persists it into conversation history. Both
 * guards live once in `makeLaneBuilder.finish()`; these tests exercise the
 * exported functions directly (whitebox) plus the end-to-end path through
 * `dispatchAgent`, and separately prove the agentless (non-tool) path is
 * byte-for-byte unchanged.
 */
import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  dispatch,
  dispatchAgent,
  guardToolExchange,
  truncateToolResultForHistory,
  MAX_TOOL_RESULT_HISTORY_BYTES,
  type Engine,
} from "@nexuscode/core";
import type { Message, ContentBlock } from "@nexuscode/shared";
import { PermissionGate, ToolRegistry, okText, type Tool } from "@nexuscode/tools";
import { createMockAdapter } from "@nexuscode/provider-mock";

function toolUseMsg(id: string, name = "echo"): Message {
  return { role: "assistant", content: [{ type: "tool_use", id, name, input: {} }] };
}

function toolResultMsg(id: string, text = "ok"): Message {
  return { role: "tool", toolCallId: id, content: [{ type: "text", text }] };
}

describe("guardToolExchange — no unpaired tool_use ever reaches the transcript", () => {
  it("leaves a correctly paired exchange untouched", () => {
    const exchange = [toolUseMsg("call_1"), toolResultMsg("call_1"), { role: "assistant", content: [{ type: "text", text: "done" }] } as Message];
    expect(guardToolExchange(exchange)).toEqual(exchange);
  });

  it("synthesizes a placeholder result for an orphaned tool_use", () => {
    const exchange = [toolUseMsg("call_1", "danger")];
    const guarded = guardToolExchange(exchange);
    expect(guarded).toHaveLength(2);
    expect(guarded[1]).toEqual({
      role: "tool",
      toolCallId: "call_1",
      name: "danger",
      content: [{ type: "text", text: "[cancelled — no result recorded]" }],
    });
  });

  it("does not insert a second placeholder for an id answered later in the array", () => {
    // Pathological ordering (result recorded before the guard sees the call in
    // iteration order is not how the loop actually builds it, but the guard
    // must not care about order — it scans the whole exchange for an answer
    // before deciding anything is orphaned).
    const exchange = [toolResultMsg("call_1", "answered"), toolUseMsg("call_1")];
    const guarded = guardToolExchange(exchange);
    expect(guarded).toHaveLength(2);
    expect(guarded.filter((m) => m.role === "tool")).toHaveLength(1);
  });

  it("handles two tool_use blocks in one assistant message, one answered and one not", () => {
    const twoCalls: Message = {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_a", name: "echo", input: {} },
        { type: "tool_use", id: "call_b", name: "echo", input: {} },
      ],
    };
    const exchange = [twoCalls, toolResultMsg("call_a")];
    const guarded = guardToolExchange(exchange);
    expect(guarded.map((m) => m.role)).toEqual(["assistant", "tool", "tool"]);
    const placeholder = guarded.find((m) => m.toolCallId === "call_b");
    expect(placeholder?.content).toEqual([{ type: "text", text: "[cancelled — no result recorded]" }]);
  });
});

describe("truncateToolResultForHistory — caps what a tool result carries into history", () => {
  it("leaves content at or under the byte cap unchanged", () => {
    const content: ContentBlock[] = [{ type: "text", text: "short result" }];
    expect(truncateToolResultForHistory(content)).toEqual(content);
  });

  it("truncates oversized content, keeping head + tail with a visible byte-count marker", () => {
    const head = "HEAD".repeat(500); // 2000 bytes, all ASCII
    const tail = "TAIL".repeat(500); // 2000 bytes
    const filler = "x".repeat(20_000);
    const original = head + filler + tail;
    const totalBytes = Buffer.byteLength(original, "utf8");
    const [block] = truncateToolResultForHistory([{ type: "text", text: original }]);
    expect(block?.type).toBe("text");
    const text = (block as { text: string }).text;
    expect(text.length).toBeLessThan(original.length);
    expect(text.startsWith(head.slice(0, 100))).toBe(true);
    expect(text.endsWith(tail.slice(-100))).toBe(true);
    expect(text).toContain(`[truncated: ${totalBytes} bytes total, showed`);
    // The marker sits BETWEEN head and tail, not appended at the end, so it
    // survives any later trim that only ever drops trailing content.
    expect(text.indexOf("[truncated:")).toBeLessThan(text.indexOf(tail.slice(0, 50)));
  });

  it("never splits a multi-byte UTF-8 character", () => {
    // Every code point here is a 4-byte emoji; a naive byte-offset slice would
    // almost certainly land mid-character and corrupt the string.
    const original = "😀".repeat(5_000);
    const [block] = truncateToolResultForHistory([{ type: "text", text: original }]);
    const text = (block as { text: string }).text;
    // A corrupted cut produces U+FFFD replacement characters; a clean
    // code-point-safe cut never does.
    expect(text).not.toContain("�");
  });

  it("passes non-text blocks through untouched", () => {
    const content: ContentBlock[] = [
      { type: "text", text: "x".repeat(20_000) },
      { type: "image", source: { type: "base64", mediaType: "image/png", data: "abc" } } as ContentBlock,
    ];
    const result = truncateToolResultForHistory(content);
    expect(result.some((b) => b.type === "image")).toBe(true);
  });
});

describe("toolExchange hardening — end to end through dispatchAgent", () => {
  it("caps an oversized tool result before it reaches RunResult.toolExchange", async () => {
    const bigTool: Tool = {
      name: "dump",
      description: "Return a large blob.",
      permission: "read",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async run() {
        return okText("D".repeat(50_000));
      },
    };
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ toolName: "dump", toolInput: () => ({}) }), {
      skipHealth: true,
    });
    const engine: Engine = createEngine({ registry });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "PING" });
    const tools = new ToolRegistry();
    tools.register(bigTool);

    const handle = dispatchAgent(
      { adapterId: "mock", model: "mock-tools", input: turn.input, idempotencyKey: "trunc1" },
      turn.context(),
      { tools, gate: new PermissionGate({ mode: "full-access" }) },
    );
    for await (const _ of handle.events()) {
      /* drain */
    }
    const outcome = await handle.outcome();
    const toolResultMsgOut = outcome.winner?.toolExchange?.find((m) => m.role === "tool");
    const text = (toolResultMsgOut?.content[0] as { text: string } | undefined)?.text ?? "";
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(50_000);
    expect(text).toContain("[truncated:");
    expect(text.length).toBeGreaterThan(0);

    await engine.dispose();
  });
});

describe("toolExchange — agentless turns are byte-for-byte unchanged", () => {
  it("a plain dispatch() (no tools) produces the exact same message shape as before this feature", async () => {
    const registry = new ProviderRegistry();
    await registry.register(createMockAdapter({ id: "spy" }), { skipHealth: true });
    const engine: Engine = createEngine({ registry });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "hello" });

    const handle = dispatch(
      {
        kind: "single",
        run: { adapterId: "spy", model: "mock-fast", input: turn.input, idempotencyKey: "fb1" },
      },
      turn.context(),
    );
    for await (const _ of handle.events()) {
      /* drain */
    }
    const outcome = await handle.outcome();

    // No agentic loop ran, so there is no exchange to thread — the new field
    // is simply absent, and the recorded reply is exactly the single
    // synthesized text message every caller has always gotten.
    expect(outcome.winner?.toolExchange).toBeUndefined();
    turn.record(outcome);
    expect(session.transcript.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(session.transcript[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: outcome.winner?.text }],
    });

    await engine.dispose();
  });
});
