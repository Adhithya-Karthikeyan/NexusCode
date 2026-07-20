/**
 * Wave 3 orchestration primitives + judges, exercised entirely offline over the
 * mock adapter: race (first cancels losers; best judged; early-error never
 * wins), consensus (quorum + merge), and chain (hand-off + optional skip).
 */

import { describe, it, expect } from "vitest";
import {
  ProviderRegistry,
  createEngine,
  dispatch,
  createChatJudge,
  createDiffJudge,
  MAX_PATCH_BYTES,
  type DispatchOptions,
  type Engine,
  type Judge,
  type RunContext,
  type RunResult,
  type Score,
  type UnifiedDiff,
} from "@nexuscode/core";
import type { Message } from "@nexuscode/shared";
import { createMockAdapter } from "@nexuscode/provider-mock";

async function newCtx(engine: Engine, prompt = "hello world"): Promise<{ ctx: RunContext; input: Message[] }> {
  const session = await engine.openSession();
  const turn = session.newTurn({ prompt });
  return { ctx: turn.context(), input: turn.input };
}

/** A registry with three mock adapters: two instant, one slow (a race window). */
async function setup(): Promise<{ engine: Engine }> {
  const reg = new ProviderRegistry();
  await reg.register(createMockAdapter({ id: "fast", models: ["mock-fast"], delayMs: 0 }));
  await reg.register(createMockAdapter({ id: "slow", models: ["mock-slow"], delayMs: 40 }));
  await reg.register(createMockAdapter({ id: "extra", models: ["mock-extra"], delayMs: 0 }));
  const engine = createEngine({ registry: reg });
  return { engine };
}

/** A fake judge that always picks the run from a chosen adapter — no model call, offline. */
function fakeJudge(pickAdapter: string): Judge {
  return {
    async rank(cands: RunResult[]): Promise<{ winner: RunResult; scores: Score[] }> {
      const winner = cands.find((c) => c.adapterId === pickAdapter) ?? cands[0]!;
      const scores: Score[] = cands.map((c) => ({ runId: c.runId, score: c === winner ? 1 : 0 }));
      return { winner, scores };
    },
    async merge(cands: RunResult[]) {
      const winner = cands.find((c) => c.adapterId === pickAdapter) ?? cands[0]!;
      return {
        text: `SYNTHESIS(${cands.length}): ${winner.text}`,
        pickedFrom: winner,
        rationale: "fake merge",
        scores: cands.map((c) => ({ runId: c.runId, score: c === winner ? 1 : 0 })),
      };
    },
    async vote(cands: RunResult[]): Promise<{ winner: RunResult; scores: Score[] }> {
      const winner = cands.find((c) => c.adapterId === pickAdapter) ?? cands[0]!;
      const scores: Score[] = cands.map((c) => ({ runId: c.runId, score: c === winner ? 1 : 0 }));
      return { winner, scores };
    },
    judgeResults: () => [],
  };
}

/**
 * A fake judge that scripts a fixed sequence of per-pass #1 winners (by
 * `adapterId`), so `judge.vote` can be exercised deterministically over the
 * mock adapter: majority-of-passes picks the winner, and a genuine tie is
 * resolved deterministically (first candidate reaching the best tie-break).
 */
function scriptedVoteJudge(passWinners: string[]): Judge {
  const notImplemented = (): never => {
    throw new Error("scriptedVoteJudge: only vote() is exercised");
  };
  return {
    rank: notImplemented,
    merge: notImplemented,
    async vote(cands: RunResult[]): Promise<{ winner: RunResult; scores: Score[] }> {
      const firstPlace = new Map<string, number>();
      for (const c of cands) firstPlace.set(c.adapterId, 0);
      for (const w of passWinners) {
        firstPlace.set(w, (firstPlace.get(w) ?? 0) + 1);
      }
      let winner = cands[0]!;
      let bestVotes = -1;
      for (const c of cands) {
        const votes = firstPlace.get(c.adapterId) ?? 0;
        if (votes > bestVotes) {
          bestVotes = votes;
          winner = c;
        }
      }
      const scores: Score[] = cands.map((c) => ({
        runId: c.runId,
        score: (firstPlace.get(c.adapterId) ?? 0) / passWinners.length,
      }));
      return { winner, scores };
    },
    judgeResults: () => [],
  };
}

describe("race — first", () => {
  it("settles on the first ok run and cancels the losers", async () => {
    const { engine } = await setup();
    const { ctx, input } = await newCtx(engine);

    const handle = dispatch(
      {
        kind: "race",
        mode: "first",
        runs: [
          { adapterId: "slow", model: "mock-slow", input, idempotencyKey: "s" },
          { adapterId: "fast", model: "mock-fast", input, idempotencyKey: "f" },
        ],
      },
      ctx,
    );

    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    expect(outcome.kind).toBe("race");
    expect(outcome.winner?.status).toBe("ok");
    expect(outcome.winner?.adapterId).toBe("fast");
    expect(outcome.partial).toBe(false);

    // The loser was cancelled (not left "ok").
    const loser = outcome.runs.find((r) => r.adapterId === "slow");
    expect(loser?.status).toBe("cancelled");

    await engine.dispose();
  });

  it("an early ERROR does not win — a healthy slower run still wins", async () => {
    const { engine } = await setup();
    const { ctx, input } = await newCtx(engine);

    const handle = dispatch(
      {
        kind: "race",
        mode: "first",
        runs: [
          // "ghost" is unknown → fails immediately, but must not win the race.
          { adapterId: "ghost", model: "x", input, idempotencyKey: "g" },
          { adapterId: "slow", model: "mock-slow", input, idempotencyKey: "s" },
        ],
      },
      ctx,
    );

    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    expect(outcome.winner?.status).toBe("ok");
    expect(outcome.winner?.adapterId).toBe("slow");
    const ghost = outcome.runs.find((r) => r.adapterId === "ghost");
    expect(ghost?.status).toBe("error");

    await engine.dispose();
  });

  it("reports partial with no winner when every run fails", async () => {
    const { engine } = await setup();
    const { ctx, input } = await newCtx(engine);

    const handle = dispatch(
      {
        kind: "race",
        mode: "first",
        runs: [
          { adapterId: "ghost1", model: "x", input, idempotencyKey: "a" },
          { adapterId: "ghost2", model: "y", input, idempotencyKey: "b" },
        ],
      },
      ctx,
    );
    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    expect(outcome.winner).toBeUndefined();
    expect(outcome.partial).toBe(true);
    expect(outcome.runs.every((r) => r.status === "error")).toBe(true);

    await engine.dispose();
  });
});

describe("race — best", () => {
  it("lets all finish and picks via the injected judge", async () => {
    const { engine } = await setup();
    const { ctx, input } = await newCtx(engine);

    const opts: DispatchOptions = { judge: fakeJudge("slow") };
    const handle = dispatch(
      {
        kind: "race",
        mode: "best",
        judge: { domain: "chat" },
        runs: [
          { adapterId: "fast", model: "mock-fast", input, idempotencyKey: "f" },
          { adapterId: "slow", model: "mock-slow", input, idempotencyKey: "s" },
        ],
      },
      ctx,
      opts,
    );

    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    // Both ran to completion (best does not cancel), and the judge chose "slow".
    expect(outcome.runs).toHaveLength(2);
    expect(outcome.runs.every((r) => r.status === "ok")).toBe(true);
    expect(outcome.winner?.adapterId).toBe("slow");
    expect(outcome.merged?.scores.length).toBe(2);

    await engine.dispose();
  });
});

describe("consensus", () => {
  it("merges with a quorum and surfaces a synthesized answer", async () => {
    const { engine } = await setup();
    const { ctx, input } = await newCtx(engine);

    const handle = dispatch(
      {
        kind: "consensus",
        judge: { domain: "chat", strategy: "merge" },
        runs: [
          { adapterId: "fast", model: "mock-fast", input, idempotencyKey: "a" },
          { adapterId: "slow", model: "mock-slow", input, idempotencyKey: "b" },
        ],
      },
      ctx,
      { judge: fakeJudge("fast") },
    );

    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    expect(outcome.kind).toBe("consensus");
    expect(outcome.merged).toBeDefined();
    expect(outcome.merged?.text).toContain("SYNTHESIS(2)");
    expect(outcome.partial).toBe(false);

    await engine.dispose();
  });

  it("fails the quorum (partial, no merge) when fewer than two runs are ok", async () => {
    const { engine } = await setup();
    const { ctx, input } = await newCtx(engine);

    const handle = dispatch(
      {
        kind: "consensus",
        judge: { domain: "chat" },
        runs: [
          { adapterId: "fast", model: "mock-fast", input, idempotencyKey: "a" },
          { adapterId: "ghost", model: "x", input, idempotencyKey: "b" },
        ],
      },
      ctx,
      { judge: fakeJudge("fast") },
    );

    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    expect(outcome.merged).toBeUndefined();
    expect(outcome.partial).toBe(true);

    await engine.dispose();
  });

  it("strategy vote dispatches to judge.vote (not merge) and the majority winner takes it", async () => {
    const { engine } = await setup();
    const { ctx, input } = await newCtx(engine);

    // 3 candidates, 3 judge passes: "slow" wins 2 of 3 first-place votes.
    const handle = dispatch(
      {
        kind: "consensus",
        judge: { domain: "chat", strategy: "vote", votes: 3 },
        runs: [
          { adapterId: "fast", model: "mock-fast", input, idempotencyKey: "a" },
          { adapterId: "slow", model: "mock-slow", input, idempotencyKey: "b" },
          { adapterId: "extra", model: "mock-extra", input, idempotencyKey: "c" },
        ],
      },
      ctx,
      { judge: scriptedVoteJudge(["slow", "fast", "slow"]) },
    );

    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    expect(outcome.kind).toBe("consensus");
    expect(outcome.merged?.rationale).toBe("consensus: majority-vote winner");
    expect(outcome.winner?.adapterId).toBe("slow");
    expect(outcome.merged?.pickedFrom?.adapterId).toBe("slow");
    expect(outcome.partial).toBe(false);

    await engine.dispose();
  });

  it("strategy vote resolves a genuine tie deterministically", async () => {
    // 3 candidates, 2 passes: "fast" and "slow" each get exactly 1 first-place
    // vote (a real tie) — the tie-break is deterministic, always picking the
    // same candidate given the same scripted passes.
    const run = async (): Promise<string | undefined> => {
      const { engine } = await setup();
      const { ctx, input } = await newCtx(engine);
      const handle = dispatch(
        {
          kind: "consensus",
          judge: { domain: "chat", strategy: "vote", votes: 2 },
          runs: [
            { adapterId: "fast", model: "mock-fast", input, idempotencyKey: "a" },
            { adapterId: "slow", model: "mock-slow", input, idempotencyKey: "b" },
            { adapterId: "extra", model: "mock-extra", input, idempotencyKey: "c" },
          ],
        },
        ctx,
        { judge: scriptedVoteJudge(["fast", "slow"]) },
      );
      for await (const _ of handle.events()) void _;
      const outcome = await handle.outcome();
      await engine.dispose();
      return outcome.winner?.adapterId;
    };

    const first = await run();
    const second = await run();
    expect(first).toBe("fast"); // first candidate reaching the best tie-break wins
    expect(second).toBe(first); // deterministic across repeated runs
  });
});

describe("chain", () => {
  it("runs stages sequentially, threading a hand-off between them", async () => {
    const { engine } = await setup();
    const { ctx, input } = await newCtx(engine, "plan this");

    const seen: Message[][] = [];
    const handle = dispatch(
      {
        kind: "chain",
        stages: [
          {
            name: "plan",
            run: { adapterId: "fast", model: "mock-fast", input, idempotencyKey: "plan" },
          },
          {
            name: "edit",
            run: { adapterId: "slow", model: "mock-slow", input: [], idempotencyKey: "edit" },
            handoff: (prev: RunResult): Message[] => {
              const msgs: Message[] = [{ role: "user", content: [{ type: "text", text: `EDIT:${prev.text}` }] }];
              seen.push(msgs);
              return msgs;
            },
          },
        ],
      },
      ctx,
    );

    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    expect(outcome.kind).toBe("chain");
    expect(outcome.runs).toHaveLength(2);
    expect(outcome.runs.every((r) => r.status === "ok")).toBe(true);
    // Stage 2 was fed the hand-off derived from stage 1's output.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]?.content[0]).toMatchObject({ text: expect.stringContaining("EDIT:[mock-fast]") });
    // The winner is the last successful stage.
    expect(outcome.winner?.adapterId).toBe("slow");

    await engine.dispose();
  });

  it("skips a failing OPTIONAL stage and continues, preserving upstream results", async () => {
    const { engine } = await setup();
    const { ctx, input } = await newCtx(engine, "start");

    const handle = dispatch(
      {
        kind: "chain",
        stages: [
          { name: "plan", run: { adapterId: "fast", model: "mock-fast", input, idempotencyKey: "p" } },
          {
            name: "flaky",
            optional: true,
            run: { adapterId: "ghost", model: "x", input: [], idempotencyKey: "flaky" },
            handoff: (prev: RunResult): Message[] => [
              { role: "user", content: [{ type: "text", text: prev.text }] },
            ],
          },
          {
            name: "review",
            run: { adapterId: "slow", model: "mock-slow", input: [], idempotencyKey: "rev" },
            handoff: (prev: RunResult): Message[] => [
              { role: "user", content: [{ type: "text", text: `REVIEW:${prev.text}` }] },
            ],
          },
        ],
      },
      ctx,
    );

    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    // All three stages executed: plan ok, flaky errored (kept), review ok.
    expect(outcome.runs).toHaveLength(3);
    const byAdapter = new Map(outcome.runs.map((r) => [r.adapterId, r.status]));
    expect(byAdapter.get("fast")).toBe("ok");
    expect(byAdapter.get("ghost")).toBe("error");
    expect(byAdapter.get("slow")).toBe("ok");
    // Partial because an executed stage failed (even though optional).
    expect(outcome.partial).toBe(true);
    // The winner is the last SUCCESSFUL stage (review), not the skipped one.
    expect(outcome.winner?.adapterId).toBe("slow");

    await engine.dispose();
  });

  it("hard-stops on a non-optional failure, preserving upstream results", async () => {
    const { engine } = await setup();
    const { ctx, input } = await newCtx(engine, "start");

    const handle = dispatch(
      {
        kind: "chain",
        stages: [
          { name: "plan", run: { adapterId: "fast", model: "mock-fast", input, idempotencyKey: "p" } },
          { name: "edit", run: { adapterId: "ghost", model: "x", input: [], idempotencyKey: "e" } },
          { name: "never", run: { adapterId: "slow", model: "mock-slow", input: [], idempotencyKey: "n" } },
        ],
      },
      ctx,
    );

    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    // Third stage never ran; the first two are preserved.
    expect(outcome.runs).toHaveLength(2);
    expect(outcome.partial).toBe(true);
    expect(outcome.winner?.adapterId).toBe("fast");

    await engine.dispose();
  });

  it("stops when a confirm gate declines, preserving upstream results", async () => {
    const { engine } = await setup();
    const { ctx, input } = await newCtx(engine, "start");

    const handle = dispatch(
      {
        kind: "chain",
        stages: [
          { name: "plan", run: { adapterId: "fast", model: "mock-fast", input, idempotencyKey: "p" } },
          {
            name: "apply",
            gate: "confirm",
            run: { adapterId: "slow", model: "mock-slow", input: [], idempotencyKey: "a" },
          },
        ],
      },
      ctx,
      { confirm: () => false },
    );

    for await (const _ of handle.events()) void _;
    const outcome = await handle.outcome();

    expect(outcome.runs).toHaveLength(1);
    expect(outcome.runs[0]?.adapterId).toBe("fast");
    expect(outcome.partial).toBe(true);

    await engine.dispose();
  });
});

describe("judges (unit, offline)", () => {
  const mkResult = (runId: string, text: string, diffs: UnifiedDiff[] = []): RunResult => ({
    runId,
    adapterId: "mock",
    model: "m",
    status: "ok",
    text,
    toolCalls: [],
    diffs,
    usage: { inputTokens: 0, outputTokens: 0 },
  });

  const dummyCtx = {} as RunContext;

  it("chat-judge anonymizes candidates and an injected scorer picks the winner", async () => {
    const seenLabels: string[] = [];
    const judge = createChatJudge(
      { domain: "chat" },
      {
        scorer: (cands) => {
          seenLabels.push(...cands.map((c) => c.label));
          // Score by label so the SECOND candidate (label "B") wins.
          return { scores: cands.map((c) => ({ label: c.label, score: c.label === "B" ? 1 : 0 })) };
        },
      },
    );

    const cands = [mkResult("r1", "alpha"), mkResult("r2", "beta"), mkResult("r3", "gamma")];
    const { winner, scores } = await judge.rank(cands, dummyCtx);

    expect(seenLabels).toEqual(["A", "B", "C"]);
    expect(winner.runId).toBe("r2");
    expect(scores.find((s) => s.runId === "r2")?.score).toBe(1);
    expect(judge.judgeResults()).toEqual([]);
  });

  it("diff-judge eliminates non-applying patches before scoring", async () => {
    const applied: string[] = [];
    const judge = createDiffJudge(
      { domain: "code" },
      {
        // Fake grounding: only patches containing "GOOD" apply.
        applyCheck: (patch) => {
          const ok = patch.includes("GOOD");
          applied.push(ok ? "ok" : "reject");
          return ok;
        },
      },
    );

    const good = mkResult("good", "", [{ path: "a.ts", patch: "+GOOD line", status: "proposed" }]);
    const bad = mkResult("bad", "", [{ path: "b.ts", patch: "+BROKEN line", status: "proposed" }]);
    const { winner, scores } = await judge.rank([bad, good], dummyCtx);

    expect(winner.runId).toBe("good");
    // The non-applying candidate is eliminated with -Infinity.
    expect(scores.find((s) => s.runId === "bad")?.score).toBe(-Infinity);
    expect(scores.find((s) => s.runId === "good")?.score).toBeGreaterThan(-Infinity);
  });

  it("diff-judge merge returns the best applyable patch as the diff", async () => {
    const judge = createDiffJudge(
      { domain: "code" },
      { applyCheck: (patch) => patch.includes("GOOD") },
    );
    const good = mkResult("good", "", [{ path: "a.ts", patch: "+GOOD", status: "proposed" }]);
    const bad = mkResult("bad", "", [{ path: "b.ts", patch: "+NOPE", status: "proposed" }]);
    const merged = await judge.merge([bad, good], dummyCtx);
    expect(merged.pickedFrom?.runId).toBe("good");
    expect(merged.diff).toEqual(good.diffs);
  });

  it("chat-judge vote runs K passes and the majority #1 winner takes it", async () => {
    // 3 passes ranking best-to-worst by label; "B" takes 2 of 3 first-place votes.
    const rankings = [
      ["B", "A", "C"],
      ["B", "C", "A"],
      ["A", "B", "C"],
    ];
    let call = 0;
    const judge = createChatJudge(
      { domain: "chat", votes: 3 },
      {
        scorer: (cands) => {
          const ranking = rankings[call]!;
          call++;
          return { scores: ranking.map((label, idx) => ({ label, score: ranking.length - idx })) };
        },
      },
    );
    const cands = [mkResult("r1", "alpha"), mkResult("r2", "beta"), mkResult("r3", "gamma")];
    const { winner, scores } = await judge.vote(cands, dummyCtx);

    expect(call).toBe(3);
    expect(winner.runId).toBe("r2"); // label "B" → r2
    expect(scores.find((s) => s.runId === "r2")?.score).toBeCloseTo(2 / 3);
  });

  it("chat-judge vote breaks a genuine tie by the lowest average rank", async () => {
    // 2 passes: "A" and "B" each get exactly one first-place vote (a real tie),
    // but "B" is consistently ranked higher on average (rank 1 then rank 2 vs.
    // "A"'s rank 1 then rank 3) so it wins deterministically.
    const rankings = [
      ["A", "B", "C"],
      ["B", "C", "A"],
    ];
    let call = 0;
    const judge = createChatJudge(
      { domain: "chat", votes: 2 },
      {
        scorer: (cands) => {
          const ranking = rankings[call]!;
          call++;
          return { scores: ranking.map((label, idx) => ({ label, score: ranking.length - idx })) };
        },
      },
    );
    const cands = [mkResult("r1", "alpha"), mkResult("r2", "beta"), mkResult("r3", "gamma")];
    const { winner } = await judge.vote(cands, dummyCtx);

    expect(winner.runId).toBe("r2"); // label "B" — same vote count, better avg rank
  });

  it("diff-judge vote scores only applyable survivors across K passes; majority wins", async () => {
    // 3 scoring passes over the two applyable survivors ("B","C"); "A" never
    // applies and must be excluded from voting entirely (-Infinity, not scored).
    const passScores: Record<string, number>[] = [
      { B: 0.9, C: 0.5 },
      { B: 0.3, C: 0.8 },
      { B: 0.7, C: 0.6 },
    ];
    let call = 0;
    const judge = createDiffJudge(
      { domain: "code", votes: 3 },
      {
        applyCheck: (patch) => patch.includes("GOOD"),
        scorer: (cands) => {
          const s = passScores[call]!;
          call++;
          return { scores: cands.map((c) => ({ label: c.label, score: s[c.label] ?? 0 })) };
        },
      },
    );
    const bad = mkResult("bad", "", [{ path: "a.ts", patch: "+BROKEN line", status: "proposed" }]);
    const good1 = mkResult("good1", "", [{ path: "b.ts", patch: "+GOOD1 line", status: "proposed" }]);
    const good2 = mkResult("good2", "", [{ path: "c.ts", patch: "+GOOD2 line", status: "proposed" }]);
    const { winner, scores } = await judge.vote([bad, good1, good2], dummyCtx);

    expect(call).toBe(3);
    expect(winner.runId).toBe("good1"); // label "B" — 2 of 3 best-patch votes
    expect(scores.find((s) => s.runId === "bad")?.score).toBe(-Infinity);
  });

  it("diff-judge vote breaks a genuine tie by the higher average score", async () => {
    const passScores: Record<string, number>[] = [
      { B: 0.9, C: 0.2 },
      { B: 0.3, C: 0.8 },
    ];
    let call = 0;
    const judge = createDiffJudge(
      { domain: "code", votes: 2 },
      {
        applyCheck: (patch) => patch.includes("GOOD"),
        scorer: (cands) => {
          const s = passScores[call]!;
          call++;
          return { scores: cands.map((c) => ({ label: c.label, score: s[c.label] ?? 0 })) };
        },
      },
    );
    const bad = mkResult("bad", "", [{ path: "a.ts", patch: "+BROKEN line", status: "proposed" }]);
    const good1 = mkResult("good1", "", [{ path: "b.ts", patch: "+GOOD1 line", status: "proposed" }]);
    const good2 = mkResult("good2", "", [{ path: "c.ts", patch: "+GOOD2 line", status: "proposed" }]);
    const { winner } = await judge.vote([bad, good1, good2], dummyCtx);

    // "good1"/"good2" each win exactly 1 of 2 passes (a real tie); "good1" has
    // the higher average score (0.6 vs 0.5) and wins the tie-break.
    expect(winner.runId).toBe("good1");
  });

  it("diff-judge vote has nothing to vote on when every patch fails to apply", async () => {
    const judge = createDiffJudge({ domain: "code" }, { applyCheck: () => false });
    const bad1 = mkResult("bad1", "", [{ path: "a.ts", patch: "+X", status: "proposed" }]);
    const bad2 = mkResult("bad2", "", [{ path: "b.ts", patch: "+Y", status: "proposed" }]);
    const { scores } = await judge.vote([bad1, bad2], dummyCtx);
    expect(scores.every((s) => s.score === -Infinity)).toBe(true);
  });

  it(
    "diff-judge rejects a pathological/oversized patch before ever shelling out to git (no hang)",
    async () => {
      // Uses the REAL default `gitApplyCheck` (no injected applyCheck) — an
      // oversized patch must be eliminated by the size cap before `git apply`
      // is ever invoked, so this resolves near-instantly instead of risking a
      // slow/hung `git` child on a multi-megabyte patch.
      const judge = createDiffJudge({ domain: "code" });
      const oversized = `+${"x".repeat(MAX_PATCH_BYTES + 1)}`;
      const huge = mkResult("huge", "", [{ path: "a.ts", patch: oversized, status: "proposed" }]);
      const { scores } = await judge.rank([huge], dummyCtx);
      expect(scores[0]?.score).toBe(-Infinity);
      expect(scores[0]?.rationale).toMatch(/size cap/i);
    },
    2000,
  );
});
