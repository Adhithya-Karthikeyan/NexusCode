import { describe, it, expect } from "vitest";
import { toNativeRequest } from "@nexuscode/provider-anthropic";
import type { AnthropicConfig } from "@nexuscode/provider-anthropic";
import type { ChatRequest } from "@nexuscode/shared";

/**
 * A `role:"tool"` message MUST become a user turn carrying a `tool_result` block
 * keyed by the originating `tool_use` id. The prior code collapsed it to a
 * plain-text user message, discarding `toolCallId` — so Anthropic 400'd every
 * tool-using follow-up ("tool_use ids were found without tool_result blocks") and
 * the turn produced no answer (tool executed ✓, then silence).
 */
const cfg: AnthropicConfig = { modelMap: {} };

function req(messages: ChatRequest["messages"]): ChatRequest {
  return { model: "claude-opus-4-1", messages };
}

describe("Anthropic tool results become tool_result blocks (not plain text)", () => {
  it("wraps a tool-role message in a tool_result block referencing the tool_use id", () => {
    const native = toNativeRequest(
      cfg,
      req([
        { role: "user", content: [{ type: "text", text: "objective?" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "kyp_ctx", input: {} }] },
        { role: "tool", toolCallId: "toolu_1", content: [{ type: "text", text: "build a harness" }] },
      ]),
    );
    const last = native.messages[native.messages.length - 1];
    expect(last.role).toBe("user");
    const block = (last.content as Array<{ type: string; tool_use_id?: string; content?: unknown }>)[0];
    expect(block.type).toBe("tool_result");
    expect(block.tool_use_id).toBe("toolu_1");
    expect(JSON.stringify(block.content)).toContain("build a harness");
  });

  it("batches parallel (consecutive) tool results into ONE user message", () => {
    const native = toNativeRequest(
      cfg,
      req([
        { role: "user", content: [{ type: "text", text: "go" }] },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "a", name: "t1", input: {} },
            { type: "tool_use", id: "b", name: "t2", input: {} },
          ],
        },
        { role: "tool", toolCallId: "a", content: [{ type: "text", text: "resA" }] },
        { role: "tool", toolCallId: "b", content: [{ type: "text", text: "resB" }] },
      ]),
    );
    // The two tool results collapse into a single trailing user message with two
    // tool_result blocks — not two separate user messages (which Anthropic rejects).
    const last = native.messages[native.messages.length - 1];
    expect(last.role).toBe("user");
    const blocks = last.content as Array<{ type: string; tool_use_id?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["a", "b"]);
    // And the assistant tool_use turn is preserved just before it.
    expect(native.messages[native.messages.length - 2].role).toBe("assistant");
  });
});
