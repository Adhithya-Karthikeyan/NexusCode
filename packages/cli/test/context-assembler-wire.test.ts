/**
 * Wire-level guard for `EngineContextAssembler`.
 *
 * This asserts on what ACTUALLY lands in the outgoing request, rather than on
 * whether each context component reports success individually. That distinction
 * matters: a previous regression retrieved context correctly and then discarded
 * it (`res.messages.slice(0, -1)` dropped the very message the engine had packed
 * the volatile lanes into), and every component involved still looked healthy.
 *
 * Two failure modes are mutually exclusive traps — fixing either one alone
 * reintroduces the other — so both are pinned here:
 *   1. retrieved context must reach the model, and
 *   2. prior conversation turns must survive,
 * with the current query appearing exactly once.
 */

import { describe, it, expect } from "vitest";
import { ContextEngine } from "@nexuscode/context";
import type { ContextChunk, ContextSource } from "@nexuscode/context";
import type { Message } from "@nexuscode/shared";
import { EngineContextAssembler } from "../src/commands.js";

const CANARY = "SECRET-CANARY-42";

/** A volatile source, i.e. the lane memory and RAG actually use. */
const retrievedSource: ContextSource = {
  id: "test-retrieved",
  priority: 10,
  kind: "volatile",
  async collect(): Promise<ContextChunk[]> {
    return [{ id: "c1", lane: "retrieved", text: `The deploy incantation is ${CANARY}.`, relevance: 1 }];
  },
};

/** A static source — these serialize into the system prefix instead. */
const conventionsSource: ContextSource = {
  id: "test-conventions",
  priority: 10,
  kind: "static",
  async collect(): Promise<ContextChunk[]> {
    return [{ id: "c2", lane: "conventions", text: "PROJECT-RULE-7: always run the suite.", relevance: 1 }];
  },
};

const text = (role: Message["role"], t: string): Message => ({ role, content: [{ type: "text", text: t }] });

const conversation: Message[] = [
  text("user", "first question"),
  text("assistant", "first answer"),
  text("user", "second question"),
];

async function assemble(sources: ContextSource[], messages: Message[] = conversation) {
  const assembler = new EngineContextAssembler(new ContextEngine(), sources, 4000);
  return assembler.assemble({ messages }, new AbortController().signal);
}

describe("EngineContextAssembler — what actually reaches the provider", () => {
  it("delivers retrieved (volatile) context into the outgoing messages", async () => {
    const out = await assemble([retrievedSource]);
    // The whole point: retrieval is useless if the result never ships.
    expect(JSON.stringify(out.messages)).toContain(CANARY);
  });

  it("preserves prior conversation turns", async () => {
    const out = await assemble([retrievedSource]);
    const wire = JSON.stringify(out.messages);
    expect(wire).toContain("first question");
    expect(wire).toContain("first answer");
  });

  it("includes the current query exactly once (no duplication)", async () => {
    const out = await assemble([retrievedSource]);
    const occurrences = JSON.stringify(out.messages).split("second question").length - 1;
    expect(occurrences).toBe(1);
  });

  it("routes static context into the system prefix", async () => {
    const out = await assemble([conventionsSource]);
    expect(out.system ?? "").toContain("PROJECT-RULE-7");
  });

  it("keeps both lanes simultaneously — static in system, volatile in messages", async () => {
    const out = await assemble([retrievedSource, conventionsSource]);
    expect(out.system ?? "").toContain("PROJECT-RULE-7");
    expect(JSON.stringify(out.messages)).toContain(CANARY);
    expect(JSON.stringify(out.messages)).toContain("first answer");
  });

  it("still returns the conversation when no source contributes anything", async () => {
    const out = await assemble([]);
    const wire = JSON.stringify(out.messages);
    expect(wire).toContain("first question");
    expect(wire).toContain("second question");
  });
});
