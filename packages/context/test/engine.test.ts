import { describe, it, expect } from "vitest";
import {
  ContextEngine,
  laneKind,
  type ContextChunk,
  type ContextSource,
} from "@nexuscode/context";

/** A trivial source that emits a fixed set of chunks. */
function source(
  id: string,
  kind: "static" | "volatile",
  priority: number,
  chunks: ContextChunk[],
): ContextSource {
  return { id, kind, priority, collect: async () => chunks };
}

const engine = new ContextEngine();

describe("ContextEngine — cache-stable ordering invariant", () => {
  it("places every STATIC-lane chunk before every VOLATILE-lane chunk", async () => {
    const res = await engine.assemble({
      budgetTokens: 10_000,
      userMessage: "do the thing",
      now: 1000,
      sources: [
        source("hist", "volatile", 40, [
          { id: "h1", lane: "history", text: "earlier turn", role: "user", createdAt: 1 },
        ]),
        source("sys", "static", 100, [
          { id: "s1", lane: "system", text: "You are NexusCode." },
        ]),
        source("mem", "static", 60, [{ id: "m1", lane: "memory", text: "convention: use TS" }]),
      ],
    });

    const kinds = res.report.included.map((c) => laneKind(c.lane));
    const lastStatic = kinds.lastIndexOf("static");
    const firstVolatile = kinds.indexOf("volatile");
    expect(lastStatic).toBeGreaterThanOrEqual(0);
    expect(firstVolatile).toBeGreaterThanOrEqual(0);
    expect(lastStatic).toBeLessThan(firstVolatile);
  });

  it("serializes the static system prefix deterministically regardless of source order", async () => {
    const s1 = source("sys", "static", 100, [{ id: "s1", lane: "system", text: "System rules." }]);
    const s2 = source("mem", "static", 60, [{ id: "m1", lane: "memory", text: "Remember X." }]);
    const a = await engine.assemble({ budgetTokens: 10_000, userMessage: "q", now: 1, sources: [s1, s2] });
    const b = await engine.assemble({ budgetTokens: 10_000, userMessage: "q", now: 1, sources: [s2, s1] });
    expect(a.system).toBe(b.system);
    expect(a.system).toContain("# System");
    expect(a.system).toContain("# Memory");
    // System lane comes before Memory lane in the serialized prefix.
    expect(a.system.indexOf("# System")).toBeLessThan(a.system.indexOf("# Memory"));
  });

  it("keeps the static prefix byte-identical when only volatile content changes (compaction seam)", async () => {
    const staticSrc = source("sys", "static", 100, [
      { id: "s1", lane: "system", text: "Stable system prompt." },
    ]);
    const base = await engine.assemble({
      budgetTokens: 10_000,
      userMessage: "hello",
      now: 1,
      sources: [staticSrc, source("hist", "volatile", 40, [{ id: "h1", lane: "history", text: "turn one", createdAt: 1 }])],
    });
    const changed = await engine.assemble({
      budgetTokens: 10_000,
      userMessage: "hello",
      now: 1,
      sources: [staticSrc, source("hist", "volatile", 40, [{ id: "h2", lane: "history", text: "a totally different turn", createdAt: 1 }])],
    });
    expect(changed.system).toBe(base.system);
  });
});

describe("ContextEngine — budget packing", () => {
  it("drops the most-volatile, least-relevant chunks first and keeps within budget", async () => {
    // Each chunk ~ 25 tokens (100 chars). Budget only fits a couple.
    const big = (n: number) => "x".repeat(100) + ` ${n}`;
    const res = await engine.assemble({
      budgetTokens: 60,
      userMessage: "q", // small
      now: 1000,
      sources: [
        source("sys", "static", 100, [{ id: "sys", lane: "system", text: big(1) }]),
        source("term", "volatile", 45, [{ id: "term", lane: "terminal", text: big(2), relevance: 0.5 }]),
        source("hist", "volatile", 40, [
          { id: "h1", lane: "history", text: big(3), createdAt: 1 },
        ]),
      ],
    });

    const includedIds = res.report.included.map((c) => c.id);
    // System (static, cache prefix) must survive.
    expect(includedIds).toContain("sys");
    // Terminal (most volatile) is dropped before history/system.
    expect(includedIds).not.toContain("term");
    expect(res.report.realTokens).toBeLessThanOrEqual(60);
    const budgetDrops = res.report.dropped.filter((d) => d.reason === "budget");
    expect(budgetDrops.map((d) => d.id)).toContain("term");
  });

  it("never drops pinned chunks and reports overBudget honestly", async () => {
    const huge = "y".repeat(400); // ~100 tokens
    const res = await engine.assemble({
      budgetTokens: 20,
      userMessage: "q",
      now: 1,
      sources: [
        source("task", "volatile", 90, [
          { id: "task", lane: "task", text: huge, pinned: true, createdAt: 1 },
        ]),
      ],
    });
    expect(res.report.included.map((c) => c.id)).toContain("task");
    expect(res.report.overBudget).toBe(true);
    expect(res.report.realTokens).toBeGreaterThan(20);
  });

  it("respects the budget with only static + user message present", async () => {
    const res = await engine.assemble({
      budgetTokens: 5,
      userMessage: "this user message alone exceeds the tiny budget by a lot",
      now: 1,
      sources: [source("sys", "static", 100, [{ id: "sys", lane: "system", text: "z".repeat(80) }])],
    });
    // Static system chunk is trimmable (not pinned) so it should be dropped.
    expect(res.report.included.map((c) => c.id)).not.toContain("sys");
    expect(res.report.userMessageTokens).toBeGreaterThan(0);
  });
});

describe("ContextEngine — dedupe", () => {
  it("collapses near-identical chunks, keeping the highest-scoring copy", async () => {
    const res = await engine.assemble({
      budgetTokens: 10_000,
      userMessage: "q",
      now: 1,
      sources: [
        source("low", "static", 10, [
          { id: "low", lane: "memory", text: "Remember   THE  Fact" },
        ]),
        source("high", "static", 90, [{ id: "high", lane: "memory", text: "remember the fact" }]),
      ],
    });
    const memIds = res.report.included.filter((c) => c.lane === "memory").map((c) => c.id);
    expect(memIds).toEqual(["high"]);
    const dupes = res.report.dropped.filter((d) => d.reason === "duplicate");
    expect(dupes.map((d) => d.id)).toContain("low");
  });
});

describe("ContextEngine — compression", () => {
  it("compresses oversized non-pinned chunks to the per-chunk cap and records it", async () => {
    const long = "word ".repeat(500); // ~625 tokens
    const res = await engine.assemble({
      budgetTokens: 10_000,
      userMessage: "q",
      now: 1,
      maxChunkTokens: 50,
      sources: [source("mem", "static", 60, [{ id: "m1", lane: "memory", text: long }])],
    });
    const inc = res.report.included.find((c) => c.id === "m1");
    expect(inc).toBeDefined();
    expect(inc!.tokens).toBeLessThanOrEqual(60); // capped (~50 + marker slack)
    const rec = res.report.compressed.find((c) => c.id === "m1");
    expect(rec).toBeDefined();
    expect(rec!.toTokens).toBeLessThan(rec!.fromTokens);
    // Static prefix still contains the (truncated) memory section.
    expect(res.system).toContain("# Memory");
    expect(res.system).toContain("…[truncated]…");
  });

  it("does not compress pinned chunks", async () => {
    const long = "word ".repeat(200);
    const res = await engine.assemble({
      budgetTokens: 10_000,
      userMessage: "q",
      now: 1,
      maxChunkTokens: 10,
      sources: [
        source("task", "volatile", 90, [
          { id: "task", lane: "task", text: long, pinned: true, createdAt: 1 },
        ]),
      ],
    });
    expect(res.report.compressed.find((c) => c.id === "task")).toBeUndefined();
  });
});

describe("ContextEngine — ContextReport correctness", () => {
  it("reports real-vs-nominal tokens, lanes, sources and cache breakpoints", async () => {
    const res = await engine.assemble({
      budgetTokens: 40,
      userMessage: "hi",
      now: 1000,
      sources: [
        source("sys", "static", 100, [{ id: "sys", lane: "system", text: "a".repeat(80) }]),
        source("mem", "static", 60, [{ id: "mem", lane: "memory", text: "b".repeat(80) }]),
        source("hist", "volatile", 40, [
          { id: "h1", lane: "history", text: "c".repeat(80), createdAt: 1 },
        ]),
      ],
    });

    const r = res.report;
    // Nominal counts everything collected; real is what survived + user message.
    expect(r.nominalTokens).toBeGreaterThan(r.realTokens);
    expect(r.realTokens).toBeLessThanOrEqual(r.budgetTokens);

    // staticTokens + volatileTokens + userMessage == realTokens.
    expect(r.staticTokens + r.volatileTokens + r.userMessageTokens).toBe(r.realTokens);
    expect(r.stablePrefixTokens).toBe(r.staticTokens);

    // Lane report is ordered by lane index and only lists included lanes.
    expect(r.lanes.length).toBeGreaterThan(0);
    const laneTokenSum = r.lanes.reduce((s, l) => s + l.tokens, 0);
    expect(laneTokenSum).toBe(r.staticTokens + r.volatileTokens);

    // Source report: every source appears with collected counts.
    expect(r.sources.map((s) => s.id).sort()).toEqual(["hist", "mem", "sys"]);
    for (const s of r.sources) expect(s.collected).toBe(1);

    // Breakpoints only sit on static lanes and are monotonically increasing.
    for (const b of r.breakpoints) expect(laneKind(b.lane)).toBe("static");
    for (let i = 1; i < r.breakpoints.length; i++) {
      expect(r.breakpoints[i]!.tokenOffset).toBeGreaterThan(r.breakpoints[i - 1]!.tokenOffset);
    }
  });

  it("caps reported breakpoints at maxBreakpoints", async () => {
    const res = await engine.assemble({
      budgetTokens: 10_000,
      userMessage: "q",
      now: 1,
      maxBreakpoints: 2,
      sources: [
        source("a", "static", 10, [{ id: "s", lane: "system", text: "sys" }]),
        source("b", "static", 10, [{ id: "t", lane: "tools", text: "tools" }]),
        source("c", "static", 10, [{ id: "m", lane: "memory", text: "mem" }]),
        source("d", "static", 10, [{ id: "cv", lane: "conventions", text: "conv" }]),
      ],
    });
    expect(res.report.breakpoints.length).toBeLessThanOrEqual(2);
  });

  it("collects from a failing source without sinking the assembly", async () => {
    const bad: ContextSource = {
      id: "bad",
      kind: "static",
      priority: 50,
      collect: async () => {
        throw new Error("boom");
      },
    };
    const res = await engine.assemble({
      budgetTokens: 1000,
      userMessage: "q",
      now: 1,
      sources: [bad, source("sys", "static", 100, [{ id: "sys", lane: "system", text: "ok" }])],
    });
    expect(res.system).toContain("ok");
    expect(res.report.sources.find((s) => s.id === "bad")!.collected).toBe(0);
  });
});

describe("ContextEngine — rendering", () => {
  it("renders history as real messages and bundles the query last", async () => {
    const res = await engine.assemble({
      budgetTokens: 10_000,
      userMessage: "current question",
      now: 1000,
      sources: [
        source("hist", "volatile", 40, [
          { id: "h1", lane: "history", text: "old user", role: "user", createdAt: 1 },
          { id: "h2", lane: "history", text: "old assistant", role: "assistant", createdAt: 2 },
        ]),
        source("task", "volatile", 90, [
          { id: "task", lane: "task", text: "Refactor the parser", createdAt: 3 },
        ]),
      ],
    });
    // history messages, then a trailing user message.
    expect(res.messages.length).toBe(3);
    expect(res.messages[0]!.role).toBe("user");
    expect(res.messages[1]!.role).toBe("assistant");
    const last = res.messages[res.messages.length - 1]!;
    expect(last.role).toBe("user");
    const lastText = last.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
    expect(lastText).toContain("Refactor the parser");
    expect(lastText).toContain("current question");
    // The task preamble comes before the actual query.
    expect(lastText.indexOf("Refactor the parser")).toBeLessThan(lastText.indexOf("current question"));
  });
});
