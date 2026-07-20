import { describe, it, expect } from "vitest";
import { ContextEngine } from "@nexuscode/context";
import type { Message } from "@nexuscode/shared";
import { EngineContextAssembler } from "../src/commands.js";

/**
 * Regression: the context assembler (run by the agent/TUI loop) must PRESERVE the
 * full conversation. It previously returned the engine's rebuilt-from-last-user
 * message list, which dropped every prior turn — so a multi-turn TUI chat became
 * amnesiac the moment it started routing through the agent loop. Assemble must
 * hand back the whole transcript (plus any static/system context), never just the
 * latest line.
 */
function text(role: "user" | "assistant", t: string): Message {
  return { role, content: [{ type: "text", text: t }] };
}

describe("EngineContextAssembler preserves multi-turn conversation history", () => {
  it("keeps every prior turn (does not collapse to the last user message)", async () => {
    const assembler = new EngineContextAssembler(new ContextEngine(), [], 4000);
    const convo: Message[] = [
      text("user", "my name is Sibi"),
      text("assistant", "Nice to meet you, Sibi."),
      text("user", "what is my name?"),
    ];

    const out = await assembler.assemble({ messages: convo }, new AbortController().signal);

    // All three turns survive, in order — the model can see the earlier context.
    expect(out.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const joined = out.messages
      .map((m) => m.content.map((c) => ("text" in c ? c.text : "")).join(""))
      .join("|");
    expect(joined).toContain("my name is Sibi");
    expect(joined).toContain("Nice to meet you");
    expect(joined).toContain("what is my name?");
  });

  it("merges a caller system prompt into the assembled system (default context prefix)", async () => {
    const assembler = new EngineContextAssembler(new ContextEngine(), [], 4000);
    const out = await assembler.assemble(
      { messages: [text("user", "hi")], system: "You are NexusCode." },
      new AbortController().signal,
    );
    expect(out.system).toContain("You are NexusCode.");
    // The single user turn is preserved (not dropped).
    expect(out.messages.map((m) => m.role)).toEqual(["user"]);
  });
});
