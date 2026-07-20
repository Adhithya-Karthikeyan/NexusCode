/**
 * THE WIRE TEST. A spy adapter captures the ACTUAL outgoing `ChatRequest` from a
 * real agent dispatch, so every claim about "the model can see X" is asserted
 * against what genuinely left the process.
 *
 * It pins four things at once, because fixing any one of them by breaking another
 * is exactly how this code has regressed before:
 *   1. retrieved (VOLATILE-lane) context reaches the provider,
 *   2. static context + the caller's system prompt reach it via `system`,
 *   3. prior conversation turns are present on turn N+1,
 *   4. the current user message appears EXACTLY ONCE (no duplication).
 *
 * History (1) regressed into `slice(0, -1)` dropping every volatile lane, after an
 * earlier fix for (3) traded one bug for the other.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { ContextEngine } from "@nexuscode/context";
import type { ContextChunk, ContextSource } from "@nexuscode/context";
import {
  ProviderRegistry,
  createEngine,
  dispatchAgent,
  type ProviderAdapter,
  type Session,
} from "@nexuscode/core";
import { PermissionGate, ToolRegistry } from "@nexuscode/tools";
import type { ChatRequest, Message } from "@nexuscode/shared";
import { createMockAdapter } from "@nexuscode/provider-mock";
import { EngineContextAssembler } from "../src/commands.js";

const SECRET = "The secret deploy incantation is xyzzy-plugh-42.";
const CONVENTION = "This project uses tabs, never spaces.";

/** A source contributing one VOLATILE chunk (like memory/RAG recall) and one STATIC chunk. */
function fakeSource(): ContextSource {
  return {
    id: "fake",
    kind: "volatile",
    priority: 5,
    async collect(): Promise<ContextChunk[]> {
      return [
        { id: "c1", lane: "retrieved", text: SECRET, relevance: 1 },
        { id: "c2", lane: "conventions", text: CONVENTION, relevance: 1 },
      ];
    },
  };
}

function spyAdapter(): { adapter: ProviderAdapter; requests: ChatRequest[] } {
  const base = createMockAdapter({ id: "spy" });
  const requests: ChatRequest[] = [];
  const adapter: ProviderAdapter = {
    ...base,
    chat(req, ctx) {
      requests.push(structuredClone(req));
      return base.chat(req, ctx);
    },
    stream(req, ctx) {
      requests.push(structuredClone(req));
      return base.stream(req, ctx);
    },
  };
  return { adapter, requests };
}

function textOf(m: Message): string {
  return m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

function bodyOf(req: ChatRequest): string {
  return req.messages.map(textOf).join("\n");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function agentTurn(session: Session, prompt: string): Promise<void> {
  const turn = session.newTurn({ prompt });
  const handle = dispatchAgent(
    { adapterId: "spy", model: "mock-fast", input: turn.input, idempotencyKey: randomUUID(), params: { system: "You are NexusCode." } },
    turn.context(),
    { tools: new ToolRegistry(), gate: new PermissionGate({ mode: "read-only" }) },
  );
  for await (const _ of handle.events()) {
    /* drain */
  }
  turn.record(await handle.outcome());
}

describe("outgoing ChatRequest — what the provider actually receives", () => {
  it("carries retrieved context, the system prefix, prior turns, and the query exactly once", async () => {
    const { adapter, requests } = spyAdapter();
    const registry = new ProviderRegistry();
    await registry.register(adapter, { skipHealth: true });
    const engine = createEngine({
      registry,
      contextAssembler: new EngineContextAssembler(new ContextEngine(), [fakeSource()], 4000),
    });
    const session = await engine.openSession();

    await agentTurn(session, "What is the secret deploy incantation?");
    await agentTurn(session, "And what about indentation?");

    expect(requests.length).toBeGreaterThanOrEqual(2);
    const first = requests[0]!;
    const last = requests[requests.length - 1]!;

    // 1. VOLATILE-lane context (recalled memory / RAG) reaches the provider.
    //    This is the assertion `slice(0, -1)` used to silently fail.
    expect(bodyOf(first)).toContain(SECRET);
    expect(bodyOf(last)).toContain(SECRET);

    // 2. STATIC-lane context rides the cache-stable system prefix, alongside the
    //    caller's own system prompt.
    expect(first.system ?? "").toContain(CONVENTION);
    expect(first.system ?? "").toContain("You are NexusCode.");

    // 3. Prior turns are present on turn 2.
    expect(bodyOf(last)).toContain("What is the secret deploy incantation?");
    expect(last.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);

    // 4. Nothing is duplicated: one copy of the query, and the context block is
    //    spliced onto the CURRENT turn only — never re-attached to prior turns,
    //    which would re-send stale context and grow every turn.
    expect(occurrences(bodyOf(last), "And what about indentation?")).toBe(1);
    const asked = last.messages.filter((m) => m.role === "user").map(textOf).join("\n");
    expect(occurrences(asked, SECRET)).toBe(1);
    // The PRIOR turn must be the user's original words, with no context block of
    // its own: enrichment happens at dispatch, the transcript keeps the raw turn.
    // Storing the enriched turn instead would re-send stale retrieval every turn
    // and grow the request without bound.
    expect(textOf(last.messages[0]!)).toBe("What is the secret deploy incantation?");
    expect(session.transcript.filter((m) => m.role === "user").map(textOf)).toEqual([
      "What is the secret deploy incantation?",
      "And what about indentation?",
    ]);
    // The static lane must NOT also leak into the messages (that would double it).
    expect(bodyOf(last)).not.toContain(CONVENTION);

    await session.dispose();
    await engine.dispose();
  });

  it("still assembles context on a first turn with no history", async () => {
    const { adapter, requests } = spyAdapter();
    const registry = new ProviderRegistry();
    await registry.register(adapter, { skipHealth: true });
    const engine = createEngine({
      registry,
      contextAssembler: new EngineContextAssembler(new ContextEngine(), [fakeSource()], 4000),
    });
    const session = await engine.openSession();

    await agentTurn(session, "hello");

    const req = requests[0]!;
    expect(req.messages).toHaveLength(1);
    expect(req.messages[0]!.role).toBe("user");
    expect(bodyOf(req)).toContain(SECRET);
    expect(occurrences(bodyOf(req), "hello")).toBe(1);

    await session.dispose();
    await engine.dispose();
  });

  it("preserves non-text content on the final user turn while adding context", async () => {
    // The context engine rebuilds its trailing turn from the last user message's
    // TEXT only. Adopting that rebuild would silently drop an attached image, so
    // the volatile context is spliced onto the caller's own message instead.
    const assembler = new EngineContextAssembler(new ContextEngine(), [fakeSource()], 4000);
    const withImage: Message = {
      role: "user",
      content: [
        { type: "text", text: "what is in this screenshot?" },
        { type: "image", mime: "image/png", data: "BASE64DATA" },
      ],
    };

    const out = await assembler.assemble({ messages: [withImage] }, new AbortController().signal);

    const finalTurn = out.messages[out.messages.length - 1]!;
    expect(finalTurn.content.some((b) => b.type === "image")).toBe(true);
    expect(textOf(finalTurn)).toContain(SECRET);
    expect(textOf(finalTurn)).toContain("what is in this screenshot?");
  });

  it("leaves the request untouched when no source contributes anything", async () => {
    const { adapter, requests } = spyAdapter();
    const registry = new ProviderRegistry();
    await registry.register(adapter, { skipHealth: true });
    const engine = createEngine({
      registry,
      contextAssembler: new EngineContextAssembler(new ContextEngine(), [], 4000),
    });
    const session = await engine.openSession();

    await agentTurn(session, "hello");

    const req = requests[0]!;
    expect(req.messages).toHaveLength(1);
    expect(textOf(req.messages[0]!)).toBe("hello");

    await session.dispose();
    await engine.dispose();
  });
});
