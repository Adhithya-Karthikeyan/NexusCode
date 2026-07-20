/**
 * `AssembleResult.volatilePreamble` — the seam that stops volatile context from
 * being silently thrown away.
 *
 * The engine bundles non-history volatile lanes (retrieved / git / terminal /
 * task) onto the trailing user message it reconstructs from `userMessage`. A
 * caller that already owns the real conversation transcript has to DROP that
 * reconstructed turn (otherwise the query is duplicated) — and in doing so it
 * loses every volatile chunk with it: RAG retrieval, recalled memory, git state.
 * `volatilePreamble` renders that same context on its own so such a caller can
 * splice it into its own final turn instead.
 */

import { describe, expect, it } from "vitest";

import { ContextEngine } from "../src/index.js";
import type { ContextChunk, ContextLane, ContextSource } from "../src/types.js";

/** A fixed source emitting one chunk on `lane`. */
function source(id: string, lane: ContextLane, text: string, priority = 50): ContextSource {
  return {
    id,
    priority,
    kind: lane === "repo-map" || lane === "conventions" ? "static" : "volatile",
    collect: async (): Promise<ContextChunk[]> => [{ id: `${id}:0`, lane, text }],
  };
}

describe("AssembleResult.volatilePreamble", () => {
  it("carries the volatile context that the reconstructed turn would take with it", async () => {
    const res = await new ContextEngine().assemble({
      budgetTokens: 4000,
      sources: [
        source("git-diff", "git", "M packages/cli/src/power.ts"),
        source("rag", "retrieved", "the fallback lives in router.ts"),
      ],
      userMessage: "where is the fallback?",
      now: 0,
    });

    // Both volatile chunks are present in the preamble…
    expect(res.volatilePreamble).toContain("M packages/cli/src/power.ts");
    expect(res.volatilePreamble).toContain("the fallback lives in router.ts");
    // …and the user's query is NOT (so splicing it in cannot duplicate the query).
    expect(res.volatilePreamble).not.toContain("where is the fallback?");

    // It is exactly the text bundled onto the trailing reconstructed turn.
    const last = res.messages[res.messages.length - 1]!;
    const blocks = last.content.map((c) => ("text" in c ? c.text : ""));
    expect(blocks[0]).toBe(res.volatilePreamble);
    expect(blocks[blocks.length - 1]).toBe("where is the fallback?");
  });

  it("dropping the reconstructed turn loses volatile context unless the preamble is used", async () => {
    const res = await new ContextEngine().assemble({
      budgetTokens: 4000,
      sources: [source("git-diff", "git", "M packages/cli/src/power.ts")],
      userMessage: "what changed?",
      now: 0,
    });

    // What a transcript-owning caller keeps when it slices off the last turn:
    const kept = JSON.stringify(res.messages.slice(0, -1));
    expect(kept).not.toContain("M packages/cli/src/power.ts");
    // The preamble is the recovery path.
    expect(res.volatilePreamble).toContain("M packages/cli/src/power.ts");
  });

  it("is absent when there is no volatile context to carry", async () => {
    const res = await new ContextEngine().assemble({
      budgetTokens: 4000,
      sources: [source("repo-map", "repo-map", "src/index.ts")],
      userMessage: "hi",
      now: 0,
    });
    // Static context rides `system`, so there is nothing to splice.
    expect(res.volatilePreamble).toBeUndefined();
    expect(res.system).toContain("src/index.ts");
  });

  it("omits volatile chunks that the budget trimmed, matching what was really sent", async () => {
    const res = await new ContextEngine().assemble({
      budgetTokens: 60,
      sources: [
        source("keep", "retrieved", "short relevant note", 90),
        source("drop", "terminal", "x".repeat(4000), 10),
      ],
      userMessage: "q",
      now: 0,
    });
    expect(res.volatilePreamble ?? "").not.toContain("x".repeat(100));
    expect(res.report.realTokens).toBeLessThanOrEqual(60);
  });
});
