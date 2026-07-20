/**
 * `diff-judge` — grounded judging of code patches (design spec §5.7).
 *
 * Discipline: coding judgments are **grounded**, never free-text. Before any
 * model spend, each candidate's patch is verified with `git apply --check` in a
 * throwaway location — non-applying patches are eliminated (`-Infinity`). Then
 * optional deterministic gates run (typecheck / lint / affected tests); a patch
 * that fails a gate also scores `-Infinity`. Only survivors reach semantic
 * scoring over the *diffs* (minimality, no unrelated churn).
 *
 * Every side-effecting seam is injectable — `applyCheck`, `gates`, `scorer` —
 * so the whole judge is exercisable offline with no real git repo, while the
 * default `applyCheck` shells out to a real `git apply --check` in production.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunContext, Judge, JudgeSpec, MergedResult, RunResult, Score, UnifiedDiff } from "../types.js";
import type { AnonCandidate, LabelScore, ScoreResult } from "./chat-judge.js";
import { anonymize } from "./chat-judge.js";

/** Context handed to grounding seams: where to apply, and the cancellation signal. */
export interface GroundingContext {
  cwd: string;
  signal: AbortSignal;
}

/** Verifies a patch applies cleanly. Default: `git apply --check` in a temp file. */
export type ApplyCheck = (patch: string, ctx: GroundingContext) => Promise<boolean> | boolean;

/** A deterministic gate (typecheck / lint / test). Returns true if the patch passes. */
export type DiffGate = (patch: string, cand: AnonCandidate, ctx: GroundingContext) => Promise<boolean> | boolean;

/** Semantic scorer over *applying* diffs. Default: a deterministic minimality heuristic. */
export type DiffScorer = (
  cands: AnonCandidate[],
  spec: JudgeSpec,
  ctx: RunContext,
) => Promise<ScoreResult> | ScoreResult;

export interface DiffJudgeOptions {
  /** Working directory the patches apply against (default `process.cwd()`). */
  cwd?: string;
  /** Override patch verification (default: real `git apply --check`). */
  applyCheck?: ApplyCheck;
  /** Optional deterministic gates run after apply-check, before scoring. */
  gates?: DiffGate[];
  /** Override semantic scoring over applying diffs (default: minimality heuristic). */
  scorer?: DiffScorer;
}

/** Join a run's unified diffs into a single patch string. */
export function candidatePatch(diffs: UnifiedDiff[]): string {
  return diffs.map((d) => d.patch).join("\n");
}

/** Count added/removed lines in a unified diff (ignores `+++`/`---` file headers). */
function patchChurn(patch: string): number {
  let n = 0;
  for (const line of patch.split("\n")) {
    if ((line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---"))) {
      n++;
    }
  }
  return n;
}

/**
 * Patches larger than this are rejected outright before ever writing them to
 * disk or shelling out to `git` — a pathological/oversized candidate is a
 * judge error, not a hang. Also enforced as `execFile`'s `maxBuffer` below.
 */
export const MAX_PATCH_BYTES = 1 << 20; // 1 MiB

/**
 * The default `applyCheck`: writes the patch to a temp file and runs
 * `git apply --check`. `timeout` bounds a hung/oversized `git` invocation (the
 * child is killed on expiry — `ctx.signal` alone does not protect against a
 * process that never receives an abort), and `maxBuffer` caps how much of the
 * child's stdout/stderr `execFile` will buffer before erroring.
 */
export const gitApplyCheck: ApplyCheck = (patch, ctx) =>
  new Promise<boolean>((resolve) => {
    void (async (): Promise<void> => {
      let dir: string | undefined;
      try {
        dir = await mkdtemp(join(tmpdir(), "nexus-diffjudge-"));
        const patchFile = join(dir, "candidate.patch");
        await writeFile(patchFile, patch.endsWith("\n") ? patch : `${patch}\n`, "utf8");
        execFile(
          "git",
          ["apply", "--check", "--whitespace=nowarn", patchFile],
          { cwd: ctx.cwd, signal: ctx.signal, timeout: 10_000, maxBuffer: MAX_PATCH_BYTES },
          (err) => {
            void rm(dir!, { recursive: true, force: true }).catch(() => undefined);
            resolve(err == null);
          },
        );
      } catch {
        if (dir) void rm(dir, { recursive: true, force: true }).catch(() => undefined);
        resolve(false);
      }
    })();
  });

/** The default semantic scorer: minimal, focused patches win (fewer churned lines). */
export function defaultDiffScorer(cands: AnonCandidate[]): ScoreResult {
  const scores: LabelScore[] = cands.map((c) => {
    const churn = patchChurn(candidatePatch(c.diffs));
    // Higher score = better. A minimal (but non-empty) patch scores highest.
    return { label: c.label, score: churn === 0 ? 0 : 1 / (1 + churn) };
  });
  return { scores };
}

/**
 * Ground every candidate: eliminate patches that don't apply or fail a gate.
 * Shared by `rank`/`merge` (single scoring pass) and `vote` (K passes) so the
 * elimination discipline — never spend model budget on a patch that can't be
 * applied — is identical across strategies.
 */
async function groundCandidates(
  anon: AnonCandidate[],
  gctx: GroundingContext,
  applyCheck: ApplyCheck,
  gates: DiffGate[],
): Promise<{ survivors: AnonCandidate[]; eliminated: Map<string, string> }> {
  const eliminated = new Map<string, string>(); // label → rationale
  const survivors: AnonCandidate[] = [];
  for (const c of anon) {
    const patch = candidatePatch(c.diffs);
    if (c.diffs.length === 0 || patch.trim().length === 0) {
      eliminated.set(c.label, "no diff produced");
      continue;
    }
    if (Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES) {
      eliminated.set(c.label, `patch exceeds the ${MAX_PATCH_BYTES}-byte size cap — rejected without applying`);
      continue;
    }
    const applies = await applyCheck(patch, gctx);
    if (!applies) {
      eliminated.set(c.label, "git apply --check failed");
      continue;
    }
    let gated = true;
    for (const gate of gates) {
      if (!(await gate(patch, c, gctx))) {
        gated = false;
        eliminated.set(c.label, "deterministic gate failed (typecheck/lint/test)");
        break;
      }
    }
    if (gated) survivors.push(c);
  }
  return { survivors, eliminated };
}

/** Default number of independent scoring passes for `strategy: "vote"`. */
const DEFAULT_VOTES = 3;

/** Build a `code` {@link Judge} that grounds every judgment in `git apply` + gates. */
export function createDiffJudge(spec: JudgeSpec, opts: DiffJudgeOptions = {}): Judge {
  const cwd = opts.cwd ?? process.cwd();
  const applyCheck = opts.applyCheck ?? gitApplyCheck;
  const scorer = opts.scorer ?? defaultDiffScorer;
  const gates = opts.gates ?? [];
  const judgeRuns: RunResult[] = [];

  const groundingCtx = (ctx: RunContext): GroundingContext => ({
    cwd,
    signal: ctx.scope?.signal ?? new AbortController().signal,
  });

  /**
   * Ground every candidate: eliminate non-applying / gate-failing patches
   * (`-Infinity`), then semantically score the survivors. Returns anonymized
   * candidates and de-anonymized scores.
   */
  const groundAndScore = async (
    cands: RunResult[],
    ctx: RunContext,
  ): Promise<{ anon: AnonCandidate[]; scores: Score[]; survivors: AnonCandidate[] }> => {
    const anon = anonymize(cands);
    const gctx = groundingCtx(ctx);
    const { survivors, eliminated } = await groundCandidates(anon, gctx, applyCheck, gates);

    const semantic = survivors.length > 0 ? await scorer(survivors, spec, ctx) : { scores: [] };
    if (semantic.judgeRuns) judgeRuns.push(...semantic.judgeRuns);
    const semanticByLabel = new Map(semantic.scores.map((s) => [s.label, s]));

    const byLabel = new Map(anon.map((a) => [a.label, a.runId]));
    const scores: Score[] = anon.map((a) => {
      const elim = eliminated.get(a.label);
      if (elim) return { runId: byLabel.get(a.label) ?? "", score: -Infinity, rationale: elim };
      const s = semanticByLabel.get(a.label);
      const score: Score = { runId: byLabel.get(a.label) ?? "", score: s?.score ?? 0 };
      if (s?.rationale !== undefined) score.rationale = s.rationale;
      return score;
    });

    return { anon, scores, survivors };
  };

  return {
    async rank(cands, ctx): Promise<{ winner: RunResult; scores: Score[] }> {
      if (cands.length === 0) throw new Error("diff-judge: no candidates to rank");
      const { scores } = await groundAndScore(cands, ctx);
      const sorted = [...scores].sort((a, b) => b.score - a.score);
      const top = sorted[0];
      const winner = (top && cands.find((c) => c.runId === top.runId)) ?? cands[0]!;
      return { winner, scores };
    },
    async vote(cands, ctx): Promise<{ winner: RunResult; scores: Score[] }> {
      if (cands.length === 0) throw new Error("diff-judge: no candidates to vote");
      const anon = anonymize(cands);
      const gctx = groundingCtx(ctx);
      const { survivors, eliminated } = await groundCandidates(anon, gctx, applyCheck, gates);
      const byLabel = new Map(anon.map((a) => [a.label, a.runId]));

      if (survivors.length === 0) {
        // No candidate patch applies at all — nothing to vote on; preserve why.
        const scores: Score[] = anon.map((a) => ({
          runId: byLabel.get(a.label) ?? "",
          score: -Infinity,
          rationale: eliminated.get(a.label) ?? "eliminated",
        }));
        return { winner: cands[0]!, scores };
      }

      const K = spec.votes ?? DEFAULT_VOTES;
      const firstPlace = new Map<string, number>(survivors.map((s) => [s.label, 0]));
      const scoreSum = new Map<string, number>(survivors.map((s) => [s.label, 0]));

      // K independent scoring passes over the applyable survivors only — never
      // spend a vote pass grounding a patch that already failed apply/gates.
      // (AST-normalized hunk merging across the winning votes is a documented
      // future enhancement; today the winner is the majority-voted patch as-is.)
      for (let pass = 0; pass < K; pass++) {
        const result = await scorer(survivors, spec, ctx);
        if (result.judgeRuns) judgeRuns.push(...result.judgeRuns);
        const passScore = new Map(result.scores.map((s) => [s.label, s.score]));
        for (const s of survivors) {
          scoreSum.set(s.label, (scoreSum.get(s.label) ?? 0) + (passScore.get(s.label) ?? 0));
        }
        const ranked = [...survivors].sort(
          (a, b) => (passScore.get(b.label) ?? -Infinity) - (passScore.get(a.label) ?? -Infinity),
        );
        const top = ranked[0];
        if (top) firstPlace.set(top.label, (firstPlace.get(top.label) ?? 0) + 1);
      }

      // Majority winner: most #1 placements across passes; ties broken by the
      // highest average score (a consistently-good patch beats an erratic one).
      let winnerLabel = survivors[0]!.label;
      let bestVotes = -1;
      let bestAvgScore = -Infinity;
      for (const s of survivors) {
        const votes = firstPlace.get(s.label) ?? 0;
        const avgScore = (scoreSum.get(s.label) ?? 0) / K;
        if (votes > bestVotes || (votes === bestVotes && avgScore > bestAvgScore)) {
          bestVotes = votes;
          bestAvgScore = avgScore;
          winnerLabel = s.label;
        }
      }

      const scores: Score[] = anon.map((a) => {
        const elim = eliminated.get(a.label);
        if (elim) return { runId: byLabel.get(a.label) ?? "", score: -Infinity, rationale: elim };
        const votes = firstPlace.get(a.label) ?? 0;
        const avgScore = (scoreSum.get(a.label) ?? 0) / K;
        return {
          runId: byLabel.get(a.label) ?? "",
          score: votes / K,
          rationale: `${votes}/${K} best-patch votes (avg score ${avgScore.toFixed(3)})`,
        };
      });

      const winnerRunId = byLabel.get(winnerLabel);
      const winner = cands.find((c) => c.runId === winnerRunId) ?? cands[0]!;
      return { winner, scores };
    },
    async merge(cands, ctx): Promise<MergedResult> {
      if (cands.length === 0) throw new Error("diff-judge: no candidates to merge");
      const { scores } = await groundAndScore(cands, ctx);
      const sorted = [...scores].sort((a, b) => b.score - a.score);
      const top = sorted[0];
      const pickedFrom = top ? cands.find((c) => c.runId === top.runId) : undefined;
      const applied = top ? Number.isFinite(top.score) : false;
      const merged: MergedResult = {
        rationale: applied
          ? `Best applyable patch (grounded score ${(top?.score ?? 0).toFixed(3)}).`
          : "No candidate patch applied cleanly; returning the top-ranked patch unverified.",
        scores,
      };
      if (pickedFrom) {
        merged.pickedFrom = pickedFrom;
        merged.diff = pickedFrom.diffs;
      }
      return merged;
    },
    judgeResults(): RunResult[] {
      return judgeRuns;
    },
  };
}
