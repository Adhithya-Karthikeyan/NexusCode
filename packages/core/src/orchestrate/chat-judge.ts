/**
 * `chat-judge` — LLM-as-judge over free-text answers (design spec §5.7).
 *
 * Discipline: chat judgments are grounded in an LLM rubric, and candidates are
 * **anonymized** (`A`, `B`, `C`, … — never by provider) so the judge cannot be
 * swayed by brand. The default rubric weights `correctness .5 / completeness
 * .25 / clarity .15 / concision .1`.
 *
 * The scoring *model call* is pluggable via {@link ChatJudgeOptions.scorer}: the
 * default is a deterministic heuristic so the judge is fully exercisable offline
 * with the mock provider, and tests can inject their own scorer (a "fake judge")
 * to script exact rankings. {@link llmChatScorer} wires a real LLM judge run for
 * production use.
 */

import type { RunContext, Judge, JudgeSpec, MergedResult, RunResult, Score } from "../types.js";

/** A candidate presented to the scorer with its identity stripped to a label. */
export interface AnonCandidate {
  /** Anonymized label (`A`, `B`, `C`, …). Never the provider identity. */
  label: string;
  /** The real run id, used to map the score back after judging. */
  runId: string;
  text: string;
  diffs: RunResult["diffs"];
}

/** A per-label score returned by a scorer, before de-anonymization. */
export interface LabelScore {
  label: string;
  score: number;
  rationale?: string;
}

/** What a scorer returns: label scores plus any judge runs (for usage accounting). */
export interface ScoreResult {
  scores: LabelScore[];
  /** The judge's own provider runs, if it made any (LLM scorers). */
  judgeRuns?: RunResult[];
}

/** The pluggable scoring seam. Receives anonymized candidates, returns label scores. */
export type ChatScorer = (
  cands: AnonCandidate[],
  spec: JudgeSpec,
  ctx: RunContext,
) => Promise<ScoreResult> | ScoreResult;

/** The pluggable merge/synthesis seam used by `merge` (writes a reconciling answer). */
export type ChatMerger = (
  cands: AnonCandidate[],
  scores: LabelScore[],
  spec: JudgeSpec,
  ctx: RunContext,
) => Promise<{ text: string; rationale: string }> | { text: string; rationale: string };

export interface ChatJudgeOptions {
  /** Override the scoring model call (default: deterministic rubric heuristic). */
  scorer?: ChatScorer;
  /** Override synthesis for `merge` (default: pick the top-scored candidate). */
  merger?: ChatMerger;
}

const DEFAULT_RUBRIC: Record<string, number> = {
  correctness: 0.5,
  completeness: 0.25,
  clarity: 0.15,
  concision: 0.1,
};

/** Default number of independent judge passes for `strategy: "vote"`. */
const DEFAULT_VOTES = 3;

/** Anonymize candidates in order → `A`, `B`, `C`, … (falls back past `Z`). */
export function anonymize(cands: RunResult[]): AnonCandidate[] {
  return cands.map((c, i) => ({
    label: i < 26 ? String.fromCharCode(65 + i) : `C${i}`,
    runId: c.runId,
    text: c.text,
    diffs: c.diffs,
  }));
}

/**
 * The default, deterministic rubric scorer. It never calls a network provider —
 * it derives a stable score from each candidate's text so the judge is testable
 * offline. Production callers inject {@link llmChatScorer} (or a custom scorer).
 */
export function defaultChatScorer(cands: AnonCandidate[], spec: JudgeSpec): ScoreResult {
  const rubric = spec.rubric ?? DEFAULT_RUBRIC;
  const weightSum = Object.values(rubric).reduce((a, b) => a + b, 0) || 1;
  const scores: LabelScore[] = cands.map((c) => {
    const len = c.text.length;
    const sentences = Math.max(1, (c.text.match(/[.!?]+/g) ?? []).length);
    // Deterministic proxies in [0,1]. `correctness` is unknown without an LLM, so
    // it is held at a neutral baseline; the real signal comes from an injected
    // LLM scorer. `completeness` rises with length; `concision` falls with it;
    // `clarity` rewards well-punctuated structure.
    const metrics: Record<string, number> = {
      correctness: 0.5,
      completeness: Math.min(1, len / 500),
      clarity: Math.min(1, sentences / 6),
      concision: 1 - Math.min(1, len / 2000),
    };
    let score = 0;
    for (const [k, w] of Object.entries(rubric)) score += (metrics[k] ?? 0) * w;
    return { label: c.label, score: score / weightSum };
  });
  return { scores };
}

/**
 * A real LLM-backed scorer: runs a single judge turn against the configured
 * model, asking it to rubric-score the anonymized candidates as strict JSON.
 * Kept out of the default path so tests stay offline; wire it in production via
 * `createChatJudge(spec, { scorer: llmChatScorer(dispatch) })`.
 *
 * `runJudge` is injected (normally the engine's `dispatch` bound to a single
 * run) so this module never imports the orchestrator and stays dependency-clean.
 */
export function llmChatScorer(
  runJudge: (prompt: string, spec: JudgeSpec, ctx: RunContext) => Promise<RunResult>,
): ChatScorer {
  return async (cands, spec, ctx): Promise<ScoreResult> => {
    const rubric = spec.rubric ?? DEFAULT_RUBRIC;
    const rubricLine = Object.entries(rubric)
      .map(([k, w]) => `${k} (${w})`)
      .join(", ");
    const body = cands.map((c) => `Candidate ${c.label}:\n${c.text}`).join("\n\n");
    const prompt =
      `You are a strict judge. Score each candidate 0..1 on this rubric: ${rubricLine}. ` +
      `Reply ONLY with JSON: {"scores":[{"label":"A","score":0.0,"rationale":"..."}]}\n\n${body}`;
    const run = await runJudge(prompt, spec, ctx);
    const parsed = parseScores(run.text, cands);
    return { scores: parsed, judgeRuns: [run] };
  };
}

/** Best-effort JSON extraction of `{scores:[...]}` from a judge's free text. */
function parseScores(text: string, cands: AnonCandidate[]): LabelScore[] {
  const known = new Set(cands.map((c) => c.label));
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      const obj = JSON.parse(match[0]) as { scores?: LabelScore[] };
      if (Array.isArray(obj.scores)) {
        const out = obj.scores.filter((s) => known.has(s.label) && typeof s.score === "number");
        if (out.length > 0) return out;
      }
    }
  } catch {
    // Fall through to a neutral score so a mangled judge reply never crashes.
  }
  return cands.map((c) => ({ label: c.label, score: 0 }));
}

/** Build a `chat` {@link Judge}. `rank` picks the highest rubric score; `merge` synthesizes. */
export function createChatJudge(spec: JudgeSpec, opts: ChatJudgeOptions = {}): Judge {
  const scorer = opts.scorer ?? defaultChatScorer;
  const judgeRuns: RunResult[] = [];

  const scoreAll = async (
    cands: RunResult[],
    ctx: RunContext,
  ): Promise<{ anon: AnonCandidate[]; scores: Score[] }> => {
    const anon = anonymize(cands);
    const result = await scorer(anon, spec, ctx);
    if (result.judgeRuns) judgeRuns.push(...result.judgeRuns);
    const byLabel = new Map(anon.map((a) => [a.label, a.runId]));
    const scores: Score[] = result.scores.map((s) => {
      const score: Score = { runId: byLabel.get(s.label) ?? "", score: s.score };
      if (s.rationale !== undefined) score.rationale = s.rationale;
      return score;
    });
    return { anon, scores };
  };

  return {
    async rank(cands, ctx): Promise<{ winner: RunResult; scores: Score[] }> {
      if (cands.length === 0) throw new Error("chat-judge: no candidates to rank");
      const { scores } = await scoreAll(cands, ctx);
      const sorted = [...scores].sort((a, b) => b.score - a.score);
      const top = sorted[0];
      const winner = (top && cands.find((c) => c.runId === top.runId)) ?? cands[0]!;
      return { winner, scores };
    },
    async vote(cands, ctx): Promise<{ winner: RunResult; scores: Score[] }> {
      if (cands.length === 0) throw new Error("chat-judge: no candidates to vote");
      const anon = anonymize(cands);
      const K = spec.votes ?? DEFAULT_VOTES;

      // Anonymized label → count of #1 placements / sum of ranks across passes.
      const firstPlace = new Map<string, number>(anon.map((a) => [a.label, 0]));
      const rankSum = new Map<string, number>(anon.map((a) => [a.label, 0]));

      // K independent judge passes: each call to `scorer` is one pass (a real
      // LLM scorer is stochastic per call; a deterministic fake can script a
      // different ranking per pass to exercise majority-vote + tie-break).
      for (let pass = 0; pass < K; pass++) {
        const result = await scorer(anon, spec, ctx);
        if (result.judgeRuns) judgeRuns.push(...result.judgeRuns);
        const byLabel = new Map(result.scores.map((s) => [s.label, s.score]));
        const ranked = [...anon].sort(
          (a, b) => (byLabel.get(b.label) ?? -Infinity) - (byLabel.get(a.label) ?? -Infinity),
        );
        ranked.forEach((c, idx) => rankSum.set(c.label, (rankSum.get(c.label) ?? 0) + (idx + 1)));
        const top = ranked[0];
        if (top) firstPlace.set(top.label, (firstPlace.get(top.label) ?? 0) + 1);
      }

      // Majority winner: most #1 placements; ties broken by the lowest average
      // rank (a candidate consistently ranked 2nd beats one alternating 1st/last).
      let winnerLabel = anon[0]!.label;
      let bestVotes = -1;
      let bestAvgRank = Infinity;
      for (const a of anon) {
        const votes = firstPlace.get(a.label) ?? 0;
        const avgRank = (rankSum.get(a.label) ?? 0) / K;
        if (votes > bestVotes || (votes === bestVotes && avgRank < bestAvgRank)) {
          bestVotes = votes;
          bestAvgRank = avgRank;
          winnerLabel = a.label;
        }
      }

      const byRunId = new Map(anon.map((a) => [a.label, a.runId]));
      const scores: Score[] = anon.map((a) => {
        const votes = firstPlace.get(a.label) ?? 0;
        const avgRank = (rankSum.get(a.label) ?? 0) / K;
        return {
          runId: byRunId.get(a.label) ?? "",
          score: votes / K,
          rationale: `${votes}/${K} first-place votes (avg rank ${avgRank.toFixed(2)})`,
        };
      });

      const winnerRunId = byRunId.get(winnerLabel);
      const winner = cands.find((c) => c.runId === winnerRunId) ?? cands[0]!;
      return { winner, scores };
    },
    async merge(cands, ctx): Promise<MergedResult> {
      if (cands.length === 0) throw new Error("chat-judge: no candidates to merge");
      const { anon, scores } = await scoreAll(cands, ctx);
      const sorted = [...scores].sort((a, b) => b.score - a.score);
      const top = sorted[0];
      const pickedFrom = top ? cands.find((c) => c.runId === top.runId) : undefined;

      if (opts.merger) {
        const labelScores: LabelScore[] = scores.map((s) => {
          const label = anon.find((a) => a.runId === s.runId)?.label ?? "?";
          const ls: LabelScore = { label, score: s.score };
          if (s.rationale !== undefined) ls.rationale = s.rationale;
          return ls;
        });
        const synth = await opts.merger(anon, labelScores, spec, ctx);
        const merged: MergedResult = { text: synth.text, rationale: synth.rationale, scores };
        if (pickedFrom) merged.pickedFrom = pickedFrom;
        return merged;
      }

      const merged: MergedResult = {
        text: pickedFrom?.text ?? "",
        rationale: `Selected the highest rubric score (${(top?.score ?? 0).toFixed(3)}) among ${cands.length} candidates.`,
        scores,
      };
      if (pickedFrom) merged.pickedFrom = pickedFrom;
      return merged;
    },
    judgeResults(): RunResult[] {
      return judgeRuns;
    },
  };
}
