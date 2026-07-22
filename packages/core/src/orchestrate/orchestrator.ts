/**
 * Orchestration dispatch. The primitive is *data*, not a hand-wired code path.
 * All five primitives are implemented: `single`, `compare`, `race`
 * (first/best+judge), `consensus` (quorum+judge) and `chain` (staged hand-offs),
 * plus `dispatchRoute` for a declarative RouteRule with transparent live failover
 * and `dispatchAgent` for the native tool loop.
 *
 * Every primitive **settles** rather than short-circuits: each lane produces a
 * `RunResult` (a failed lane becomes `status:"error"`, never discarded), judge
 * runs fold into the aggregated `usage`, and the outcome reports `partial`.
 */

import {
  AdapterError,
  NexusError,
  computeCost,
  sumUsage,
  userText,
  type Capabilities,
  type ChatRequest,
  type FinishReason,
  type Message,
  type StreamChunk,
  type ToolDef,
  type Usage,
} from "@nexuscode/shared";
import {
  errText,
  runTool,
  toolResultChunk,
  type PermissionGate,
  type Tool,
  type ToolContext,
  type ToolRegistry,
  type ToolResult,
} from "@nexuscode/tools";
import { randomUUID } from "node:crypto";
import type { CallContext, ProviderAdapter } from "../adapter.js";
import type { Labeled } from "../bus.js";
import type { CancelScope } from "../cancel.js";
import { DEFAULT_RETRY_POLICY, withRetry } from "../resilience.js";
import {
  spanEnd,
  spanFirstToken,
  spanStart,
  type EngineSpanKind,
  type EngineSpanStatus,
} from "../trace.js";
import {
  Router,
  registryRunFactory,
  runWithFailover,
  type FailoverEvent,
  type RouteCandidate,
  type RouteRule,
  type RouterMetadata,
} from "../router.js";
import type {
  ChainStage,
  ContextAssembler,
  Judge,
  OrchestrationHandle,
  OrchestrationKind,
  OrchestrationOutcome,
  OrchestrationSpec,
  PricingTable,
  Run,
  RunContext,
  RunResult,
  RunSpec,
  RunStatus,
  SamplingParams,
  ToolCall,
  UnifiedDiff,
} from "../types.js";
import { createJudge, type CreateJudgeOptions } from "./judge.js";

// ── An unbounded async queue used to fan the merged stream to `events()` ──────

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private resolvers: Array<{
    resolve: (r: IteratorResult<T>) => void;
    reject: (e: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  push(item: T): void {
    if (this.closed) return;
    const r = this.resolvers.shift();
    if (r) r.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.resolvers) r.resolve({ value: undefined, done: true } as IteratorResult<T>);
    this.resolvers = [];
  }

  fail(e: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failure = e;
    for (const r of this.resolvers) r.reject(e);
    this.resolvers = [];
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.closed) {
        if (this.failure) throw this.failure;
        return;
      }
      const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
        this.resolvers.push({ resolve, reject });
      });
      if (result.done) {
        if (this.failure) throw this.failure;
        return;
      }
      yield result.value;
    }
  }
}

// ── RunSpec → Run wiring ──────────────────────────────────────────────────────

function specToRequest(spec: RunSpec): ChatRequest {
  const req: ChatRequest = { model: spec.model, messages: spec.input };
  const p = spec.params;
  if (p) {
    if (p.system !== undefined) req.system = p.system;
    if (p.maxTokens !== undefined) req.maxTokens = p.maxTokens;
    if (p.temperature !== undefined) req.temperature = p.temperature;
    if (p.reasoning !== undefined) req.reasoning = p.reasoning;
  }
  return req;
}

function makeCallContext(runId: string, spec: RunSpec, scope: CancelScope, ctx: RunContext): CallContext {
  const c: CallContext = {
    signal: scope.signal,
    idempotencyKey: spec.idempotencyKey,
    traceId: ctx.turnId,
    runId,
  };
  if (ctx.emit) c.emit = ctx.emit;
  return c;
}

/** Stamp a real runId onto synthetic chunks (withRetry emits `runId:""`). */
async function* stampRunId(source: AsyncIterable<StreamChunk>, runId: string): AsyncIterable<StreamChunk> {
  for await (const chunk of source) {
    yield chunk.runId === "" ? ({ ...chunk, runId } as StreamChunk) : chunk;
  }
}

/** The span kind a provider run reports: subprocess CLIs nest as `subprocess`. */
function runSpanKind(ctx: RunContext, adapterId: string): EngineSpanKind {
  try {
    return ctx.registry.get(adapterId).transport === "cli-subprocess" ? "subprocess" : "run";
  } catch {
    return "run";
  }
}

/**
 * Instrument one provider run as a span: brackets the stream with `span.start`
 * / `span.end` (through `ctx.emit`), emits `span.first-token` on the first
 * answer delta (TTFT), and folds the run's usage + terminal status into the end
 * event. A no-op passthrough when no `emit` sink is wired, so the untraced path
 * is unchanged.
 */
async function* traceRunStream(
  source: AsyncIterable<StreamChunk>,
  runId: string,
  spec: RunSpec,
  ctx: RunContext,
  kind: EngineSpanKind,
): AsyncIterable<StreamChunk> {
  const emit = ctx.emit;
  if (!emit) {
    yield* source;
    return;
  }
  const traceId = ctx.turnId;
  emit(
    spanStart(traceId, runId, {
      name: `${spec.adapterId}:${spec.model}`,
      kind,
      runId,
      attributes: { "nexus.provider": spec.adapterId, "nexus.model": spec.model },
    }),
  );
  let firstToken = false;
  let sawUsage = false;
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let status: EngineSpanStatus = "ok";
  let message: string | undefined;
  try {
    for await (const chunk of source) {
      if (!firstToken && chunk.type === "text-delta" && chunk.channel !== "reasoning") {
        firstToken = true;
        emit(spanFirstToken(traceId, runId, { runId }));
      }
      if (chunk.type === "usage") {
        mergeUsage(usage, chunk.usage);
        sawUsage = true;
      } else if (chunk.type === "run-end") {
        if (chunk.usage) {
          mergeUsage(usage, chunk.usage);
          sawUsage = true;
        }
        if (chunk.finishReason === "error") status = "error";
        else if (chunk.finishReason === "cancelled") status = "cancelled";
      } else if (chunk.type === "error") {
        status = chunk.error.code === "cancelled" ? "cancelled" : "error";
        message = chunk.error.message;
      }
      yield chunk;
    }
  } finally {
    emit(
      spanEnd(traceId, runId, {
        status,
        ...(message !== undefined ? { message } : {}),
        ...(sawUsage ? { usage } : {}),
        runId,
      }),
    );
  }
}

function makeRun(spec: RunSpec, ctx: RunContext): Run {
  const runId = `run_${randomUUID()}`;
  return {
    id: runId,
    spec,
    stream(scope: CancelScope): AsyncIterable<StreamChunk> {
      const policy = ctx.retryPolicy ?? DEFAULT_RETRY_POLICY;
      const req = specToRequest(spec);
      const attempt = (): AsyncIterable<StreamChunk> => {
        const adapter = ctx.registry.get(spec.adapterId); // throws → folded to error chunk
        return adapter.stream(req, makeCallContext(runId, spec, scope, ctx));
      };
      const base = stampRunId(withRetry(attempt, policy, scope.signal), runId);
      return traceRunStream(base, runId, spec, ctx, runSpanKind(ctx, spec.adapterId));
    },
  };
}

// ── Per-lane result accumulation ──────────────────────────────────────────────

function mergeUsage(target: Usage, partial: Partial<Usage>): void {
  if (partial.inputTokens != null) target.inputTokens = partial.inputTokens;
  if (partial.outputTokens != null) target.outputTokens = partial.outputTokens;
  if (partial.cacheReadTokens != null) target.cacheReadTokens = partial.cacheReadTokens;
  if (partial.cacheWriteTokens != null) target.cacheWriteTokens = partial.cacheWriteTokens;
  if (partial.reasoningTokens != null) target.reasoningTokens = partial.reasoningTokens;
  if (partial.reportedCostUsd != null) target.reportedCostUsd = partial.reportedCostUsd;
}

interface LaneBuilder {
  consume(chunk: StreamChunk): void;
  finish(pricing?: PricingTable): RunResult;
}

function makeLaneBuilder(spec: RunSpec, runId: string): LaneBuilder {
  let text = "";
  const toolCalls: ToolCall[] = [];
  const openTools = new Map<string, { name: string; args: string }>();
  const diffs: UnifiedDiff[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let status: RunStatus = "ok";
  let finishReason: FinishReason | undefined;
  let error: AdapterError | undefined;
  let sawTerminal = false;

  const statusFor = (fr: FinishReason): RunStatus =>
    fr === "cancelled" ? "cancelled" : fr === "error" ? "error" : "ok";

  return {
    consume(chunk: StreamChunk): void {
      switch (chunk.type) {
        case "text-delta":
          if (chunk.channel !== "reasoning") text += chunk.text;
          break;
        case "tool-call-start":
          openTools.set(chunk.id, { name: chunk.name, args: "" });
          break;
        case "tool-call-delta": {
          const t = openTools.get(chunk.id);
          if (t) t.args += chunk.argsJsonDelta;
          break;
        }
        case "tool-call-end": {
          const t = openTools.get(chunk.id);
          toolCalls.push({ id: chunk.id, name: t?.name ?? "", input: chunk.input });
          openTools.delete(chunk.id);
          break;
        }
        case "file-edit":
          diffs.push({ path: chunk.path, patch: chunk.diff, status: chunk.status });
          break;
        case "usage":
          mergeUsage(usage, chunk.usage);
          break;
        case "run-end":
          sawTerminal = true;
          finishReason = chunk.finishReason;
          if (chunk.usage) mergeUsage(usage, chunk.usage);
          status = statusFor(chunk.finishReason);
          break;
        case "error":
          sawTerminal = true;
          error = chunk.error;
          status = chunk.error.code === "cancelled" ? "cancelled" : "error";
          finishReason = chunk.error.code === "cancelled" ? "cancelled" : "error";
          break;
        default:
          break;
      }
    },
    finish(pricing?: PricingTable): RunResult {
      if (!sawTerminal && status === "ok") {
        // Stream ended without a terminal chunk → treat as an error, not success.
        status = "error";
        error = new AdapterError("empty_output", "stream ended without a terminal chunk", {
          providerId: spec.adapterId,
        });
        finishReason = "error";
      }
      const price = pricing?.[spec.model];
      if (price) usage.costUsd = computeCost(usage, price);
      else if (usage.reportedCostUsd != null) usage.costUsd = usage.reportedCostUsd;

      const result: RunResult = {
        runId,
        adapterId: spec.adapterId,
        model: spec.model,
        status,
        text,
        toolCalls,
        diffs,
        usage,
      };
      if (finishReason !== undefined) result.finishReason = finishReason;
      if (error !== undefined) result.error = error;
      return result;
    },
  };
}

// ── Lane orchestration (single + compare) ─────────────────────────────────────

function runLanes(kind: OrchestrationKind, specs: RunSpec[], ctx: RunContext): OrchestrationHandle {
  const scope = ctx.scope.child();
  const queue = new AsyncQueue<Labeled<StreamChunk>>();
  const runs = specs.map((s) => makeRun(s, ctx));
  const builders = runs.map((r) => makeLaneBuilder(r.spec, r.id));

  let resolveOutcome!: (o: OrchestrationOutcome) => void;
  let rejectOutcome!: (e: unknown) => void;
  const outcomePromise = new Promise<OrchestrationOutcome>((res, rej) => {
    resolveOutcome = res;
    rejectOutcome = rej;
  });

  const orchSpanKey = `orchestrate:${randomUUID()}`;

  const pump = async (): Promise<void> => {
    // Bracket the whole orchestration in one span so the per-run spans nest
    // under it (a `single` dispatch is a one-lane orchestration).
    ctx.emit?.(
      spanStart(ctx.turnId, orchSpanKey, {
        name: `${kind} (${specs.length} lane${specs.length === 1 ? "" : "s"})`,
        kind: "orchestration",
        attributes: { "nexus.orchestration": kind, "nexus.lanes": specs.length },
      }),
    );
    const laneStreams = runs.map((run, laneIndex) => {
      const runScope = scope.child();
      return ctx.bus.publish(run.stream(runScope), { runId: run.id, laneIndex });
    });
    const merged = ctx.bus.merge(laneStreams);

    for await (const labeled of merged) {
      const builder = builders[labeled.laneIndex];
      if (builder) builder.consume(labeled.chunk);
      if (ctx.store) {
        try {
          await ctx.store.append({
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            runId: labeled.runId,
            seq: labeled.seq,
            chunk: labeled.chunk,
          });
        } catch (e) {
          ctx.emit?.({ type: "store-error", traceId: ctx.turnId, ts: Date.now(), data: String(e) });
        }
      }
      queue.push(labeled);
    }

    const results = builders.map((b) => b.finish(ctx.pricing));
    if (ctx.store) {
      for (const r of results) {
        try {
          await ctx.store.summarize({ ...r, sessionId: ctx.sessionId, turnId: ctx.turnId });
        } catch (e) {
          ctx.emit?.({ type: "store-error", traceId: ctx.turnId, ts: Date.now(), data: String(e) });
        }
      }
    }

    const outcome: OrchestrationOutcome = {
      kind,
      runs: results,
      usage: sumUsage(results.map((r) => r.usage)),
      partial: results.some((r) => r.status !== "ok"),
    };
    if (kind === "single" && results[0]) outcome.winner = results[0];
    ctx.emit?.(
      spanEnd(ctx.turnId, orchSpanKey, {
        status: outcome.partial ? "error" : "ok",
        attributes: {
          "nexus.usage.input": outcome.usage.inputTokens,
          "nexus.usage.output": outcome.usage.outputTokens,
        },
      }),
    );
    resolveOutcome(outcome);
    queue.close();
  };

  pump().catch((e: unknown) => {
    rejectOutcome(e);
    queue.fail(e);
  });

  return {
    scope,
    events: () => queue,
    outcome: () => outcomePromise,
  };
}

/**
 * Optional injectable seams for the judged / gated primitives. Everything here
 * is optional so `dispatch(spec, ctx)` keeps working unchanged; tests inject a
 * fake `judge` (or a `confirm` gate) to stay fully offline.
 */
export interface DispatchOptions {
  /** Override the judge used by `race best` / `consensus` (built from the spec otherwise). */
  judge?: Judge;
  /** Options threaded to the default `createJudge` when no `judge` is injected. */
  judgeOptions?: CreateJudgeOptions;
  /** Human approval gate for chain stages with `gate: "confirm"` (default: allow). */
  confirm?: (stage: ChainStage, prev: RunResult | undefined) => boolean | Promise<boolean>;
  /** `race best` upper bound: cancel still-running lanes after this many ms. */
  bestTimeoutMs?: number;
}

/**
 * Dispatch an orchestration spec. Returns a handle exposing a live labeled event
 * stream and a settled outcome. Every primitive **settles** rather than
 * short-circuits and reports `partial`.
 */
export function dispatch(
  spec: OrchestrationSpec,
  ctx: RunContext,
  opts: DispatchOptions = {},
): OrchestrationHandle {
  switch (spec.kind) {
    case "single":
      return runLanes("single", [spec.run], ctx);
    case "compare":
      return runLanes("compare", spec.runs, ctx);
    case "race":
      return runRace(spec, ctx, opts);
    case "consensus":
      return runConsensus(spec, ctx, opts);
    case "chain":
      return runChain(spec, ctx, opts);
    default: {
      const _exhaustive: never = spec;
      throw new NexusError("internal", `unknown orchestration kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

// ── Shared plumbing for the judged / sequential primitives ────────────────────

/** The terminal status a run-end/error chunk implies (matches the lane builder). */
function terminalStatusOf(chunk: Extract<StreamChunk, { type: "run-end" | "error" }>): RunStatus {
  if (chunk.type === "error") return chunk.error.code === "cancelled" ? "cancelled" : "error";
  const fr = chunk.finishReason;
  return fr === "cancelled" ? "cancelled" : fr === "error" ? "error" : "ok";
}

/** Append one labeled chunk to the store (best-effort; never sinks the run). */
async function persistAppend(ctx: RunContext, labeled: Labeled<StreamChunk>): Promise<void> {
  if (!ctx.store) return;
  try {
    await ctx.store.append({
      sessionId: ctx.sessionId,
      turnId: ctx.turnId,
      runId: labeled.runId,
      seq: labeled.seq,
      chunk: labeled.chunk,
    });
  } catch (e) {
    ctx.emit?.({ type: "store-error", traceId: ctx.turnId, ts: Date.now(), data: String(e) });
  }
}

/** Summarize settled results into the store (best-effort). */
async function persistSummaries(ctx: RunContext, results: RunResult[]): Promise<void> {
  if (!ctx.store) return;
  for (const r of results) {
    try {
      await ctx.store.summarize({ ...r, sessionId: ctx.sessionId, turnId: ctx.turnId });
    } catch (e) {
      ctx.emit?.({ type: "store-error", traceId: ctx.turnId, ts: Date.now(), data: String(e) });
    }
  }
}

/** Wrap a primitive's async body in the standard handle (queue + outcome promise). */
function runPrimitive(
  scope: CancelScope,
  body: (queue: AsyncQueue<Labeled<StreamChunk>>) => Promise<OrchestrationOutcome>,
): OrchestrationHandle {
  const queue = new AsyncQueue<Labeled<StreamChunk>>();
  let resolveOutcome!: (o: OrchestrationOutcome) => void;
  let rejectOutcome!: (e: unknown) => void;
  const outcomePromise = new Promise<OrchestrationOutcome>((res, rej) => {
    resolveOutcome = res;
    rejectOutcome = rej;
  });

  body(queue)
    .then((o) => {
      resolveOutcome(o);
      queue.close();
    })
    .catch((e: unknown) => {
      rejectOutcome(e);
      queue.fail(e);
    });

  return { scope, events: () => queue, outcome: () => outcomePromise };
}

/**
 * Run N specs concurrently under per-lane child scopes, fanning every chunk to
 * `queue` and the store. `onLaneTerminal` fires the moment a lane's terminal
 * chunk is observed (before the merge drains), receiving the per-lane scopes so
 * a caller can cancel losers (race `first`). Settles every lane into a
 * `RunResult`. Returns the results in lane order.
 */
async function driveConcurrent(
  specs: RunSpec[],
  ctx: RunContext,
  queue: AsyncQueue<Labeled<StreamChunk>>,
  laneScopes: CancelScope[],
  onLaneTerminal?: (laneIndex: number, status: RunStatus, laneScopes: CancelScope[]) => void,
): Promise<RunResult[]> {
  const runs = specs.map((s) => makeRun(s, ctx));
  const builders = runs.map((r) => makeLaneBuilder(r.spec, r.id));
  const laneStreams = runs.map((run, i) =>
    ctx.bus.publish(run.stream(laneScopes[i]!), { runId: run.id, laneIndex: i }),
  );
  const merged = ctx.bus.merge(laneStreams);

  for await (const labeled of merged) {
    const builder = builders[labeled.laneIndex];
    if (builder) builder.consume(labeled.chunk);
    await persistAppend(ctx, labeled);
    queue.push(labeled);
    if (onLaneTerminal && (labeled.chunk.type === "run-end" || labeled.chunk.type === "error")) {
      onLaneTerminal(labeled.laneIndex, terminalStatusOf(labeled.chunk), laneScopes);
    }
  }

  const results = builders.map((b) => b.finish(ctx.pricing));
  await persistSummaries(ctx, results);
  return results;
}

/** Run a single spec as one lane to completion; return its settled result. */
async function driveOne(
  spec: RunSpec,
  ctx: RunContext,
  scope: CancelScope,
  queue: AsyncQueue<Labeled<StreamChunk>>,
  laneIndex: number,
): Promise<RunResult> {
  const run = makeRun(spec, ctx);
  const builder = makeLaneBuilder(run.spec, run.id);
  const laneScope = scope.child();
  const labeledStream = ctx.bus.publish(run.stream(laneScope), { runId: run.id, laneIndex });
  for await (const labeled of labeledStream) {
    builder.consume(labeled.chunk);
    await persistAppend(ctx, labeled);
    queue.push(labeled);
  }
  const result = builder.finish(ctx.pricing);
  await persistSummaries(ctx, [result]);
  return result;
}

/** Aggregate lane usage plus any judge-run usage into one `Usage`. */
function totalUsage(results: RunResult[], judge?: Judge): Usage {
  const usages = results.map((r) => r.usage);
  if (judge) for (const jr of judge.judgeResults()) usages.push(jr.usage);
  return sumUsage(usages);
}

// ── race ──────────────────────────────────────────────────────────────────────

function runRace(
  spec: Extract<OrchestrationSpec, { kind: "race" }>,
  ctx: RunContext,
  opts: DispatchOptions,
): OrchestrationHandle {
  const scope = ctx.scope.child();
  return runPrimitive(scope, async (queue) => {
    const laneScopes = spec.runs.map(() => scope.child());

    let results: RunResult[];
    let winner: RunResult | undefined;

    if (spec.mode === "first") {
      // Settle on the FIRST run reaching a terminal with status ok; cancel the
      // losers. An early ERROR terminal is status "error", so it never wins —
      // the guard against a fast failure stealing the race.
      let winnerIndex: number | undefined;
      results = await driveConcurrent(spec.runs, ctx, queue, laneScopes, (laneIndex, status, scopes) => {
        if (winnerIndex === undefined && status === "ok") {
          winnerIndex = laneIndex;
          scopes.forEach((s, i) => {
            if (i !== laneIndex) void s.cancel("race-won");
          });
        }
      });
      winner = winnerIndex !== undefined ? results[winnerIndex] : undefined;
    } else {
      // best: let all finish (or a best-timeout), then a judge scores + picks.
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (opts.bestTimeoutMs !== undefined && opts.bestTimeoutMs >= 0) {
        timer = setTimeout(() => {
          for (const s of laneScopes) void s.cancel("timeout");
        }, opts.bestTimeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      }
      try {
        results = await driveConcurrent(spec.runs, ctx, queue, laneScopes);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const okCands = results.filter((r) => r.status === "ok");
      if (okCands.length > 0) {
        if (spec.judge) {
          const judge = opts.judge ?? createJudge(spec.judge, opts.judgeOptions);
          const ranked = await judge.rank(okCands, ctx);
          winner = ranked.winner;
          const merged = {
            text: ranked.winner.text,
            pickedFrom: ranked.winner,
            rationale: "race best: judge-ranked winner",
            scores: ranked.scores,
          };
          return {
            kind: "race",
            runs: results,
            winner,
            merged,
            usage: totalUsage(results, judge),
            partial: results.some((r) => r.status !== "ok"),
          };
        }
        // No judge → the first healthy result is the winner.
        winner = okCands[0];
      }
    }

    const outcome: OrchestrationOutcome = {
      kind: "race",
      runs: results,
      usage: totalUsage(results),
      // A healthy run winning is a clean race; partial is reserved for "no winner".
      partial: winner === undefined,
    };
    if (winner) outcome.winner = winner;
    return outcome;
  });
}

// ── consensus ─────────────────────────────────────────────────────────────────

function runConsensus(
  spec: Extract<OrchestrationSpec, { kind: "consensus" }>,
  ctx: RunContext,
  opts: DispatchOptions,
): OrchestrationHandle {
  const scope = ctx.scope.child();
  return runPrimitive(scope, async (queue) => {
    const laneScopes = spec.runs.map(() => scope.child());
    const results = await driveConcurrent(spec.runs, ctx, queue, laneScopes);
    const okCands = results.filter((r) => r.status === "ok");

    // Quorum: consensus needs at least two OK runs to reconcile.
    if (okCands.length < 2) {
      return {
        kind: "consensus",
        runs: results,
        usage: totalUsage(results),
        partial: true,
      };
    }

    const judge = opts.judge ?? createJudge(spec.judge, opts.judgeOptions);
    const strategy = spec.judge.strategy ?? "merge";
    let merged;
    let winner: RunResult | undefined;
    if (strategy === "rank") {
      const ranked = await judge.rank(okCands, ctx);
      winner = ranked.winner;
      merged = {
        text: ranked.winner.text,
        pickedFrom: ranked.winner,
        rationale: "consensus: judge-ranked pick",
        scores: ranked.scores,
      };
    } else if (strategy === "vote") {
      const voted = await judge.vote(okCands, ctx);
      winner = voted.winner;
      merged = {
        text: voted.winner.text,
        pickedFrom: voted.winner,
        rationale: "consensus: majority-vote winner",
        scores: voted.scores,
      };
    } else {
      // "merge" (synthesis) reduces to the judge's merge.
      merged = await judge.merge(okCands, ctx);
      winner = merged.pickedFrom;
    }

    const outcome: OrchestrationOutcome = {
      kind: "consensus",
      runs: results,
      merged,
      usage: totalUsage(results, judge),
      // Quorum met but some lanes failed → still partial (they were dropped).
      partial: results.some((r) => r.status !== "ok"),
    };
    if (winner) outcome.winner = winner;
    return outcome;
  });
}

// ── chain ─────────────────────────────────────────────────────────────────────

/** Default hand-off when a stage declares none: append the previous text as a user turn. */
function defaultHandoff(prev: RunResult, stage: ChainStage): Message[] {
  return [...stage.run.input, ...userText(prev.text)];
}

function runChain(
  spec: Extract<OrchestrationSpec, { kind: "chain" }>,
  ctx: RunContext,
  opts: DispatchOptions,
): OrchestrationHandle {
  const scope = ctx.scope.child();
  return runPrimitive(scope, async (queue) => {
    const results: RunResult[] = [];
    let prev: RunResult | undefined; // last SUCCESSFUL result — the hand-off source
    let lastOk: RunResult | undefined;
    let laneIndex = 0;
    let stopped = false;

    for (const stage of spec.stages) {
      // Build this stage's input from the previous successful result.
      let runSpec = stage.run;
      if (prev) {
        const input = stage.handoff ? stage.handoff(prev) : defaultHandoff(prev, stage);
        runSpec = { ...stage.run, input };
      }

      // Human approval gate. A declined confirm stops the chain, preserving all
      // upstream results (never a hard failure).
      if (stage.gate === "confirm") {
        const approved = opts.confirm ? await opts.confirm(stage, prev) : true;
        if (!approved) {
          stopped = true;
          break;
        }
      }

      const result = await driveOne(runSpec, ctx, scope, queue, laneIndex);
      results.push(result);
      laneIndex++;

      if (result.status === "ok") {
        prev = result;
        lastOk = result;
        continue;
      }

      // Failed stage: `optional` → skip and keep going from the last good result;
      // otherwise hard-stop with upstream results preserved.
      if (stage.optional) continue;
      stopped = true;
      break;
    }

    const outcome: OrchestrationOutcome = {
      kind: "chain",
      runs: results,
      usage: totalUsage(results),
      // Partial when we stopped early or any executed stage failed.
      partial: stopped || results.length < spec.stages.length || results.some((r) => r.status !== "ok"),
    };
    if (lastOk) outcome.winner = lastOk;
    return outcome;
  });
}

// ── route (declarative routing + live failover) ───────────────────────────────

/**
 * A routed run: a {@link RouteRule} + the turn input. The router resolves the
 * rule into an ordered candidate list against the live registry, then the run
 * streams the winner with transparent live failover — the same
 * `OrchestrationHandle` the other primitives return, so the CLI/TUI subscribe
 * identically. The winning candidate's `run-start` carries the `raw.failover`
 * trail (surfaced as `failover` UiEvents) so a hand-off is visible.
 */
export interface RouteRunSpec {
  rule: RouteRule;
  input: Message[];
  params?: SamplingParams;
  idempotencyKey: string;
  /** Config-derived cost/latency/quality metadata the router orders by. */
  meta?: RouterMetadata;
  /** Only keep providers whose capabilities satisfy this predicate. */
  capabilitiesNeeded?: (caps: Capabilities) => boolean;
}

/** Options for {@link dispatchRoute}. */
export interface RouteDispatchOptions {
  /** Fires the moment a live-failover hand-off happens (UI "failed over A → B"). */
  onFailover?: (e: FailoverEvent) => void;
}

/**
 * Resolve a {@link RouteRule} into the ordered candidate list it would run,
 * without dispatching. Pure over the rule + the current registry — the CLI's
 * `route explain` renders exactly this.
 */
export function selectRoute(spec: RouteRunSpec, ctx: RunContext): RouteCandidate[] {
  const router = new Router(spec.meta ?? {});
  return router.select(spec.rule, {
    registry: ctx.registry,
    ...(spec.capabilitiesNeeded ? { capabilitiesNeeded: spec.capabilitiesNeeded } : {}),
  });
}

/**
 * Dispatch a routed run. Selects candidates via the {@link Router}, then streams
 * the winner through {@link runWithFailover} (same-provider retries first, then a
 * transparent provider switch on a pre-first-chunk failover-eligible error).
 * Settles into a `single`-kind outcome whose `winner`/`runs[0]` reflect the
 * provider that actually answered.
 */
export function dispatchRoute(
  spec: RouteRunSpec,
  ctx: RunContext,
  opts: RouteDispatchOptions = {},
): OrchestrationHandle {
  const scope = ctx.scope.child();
  return runPrimitive(scope, async (queue) => {
    const candidates = selectRoute(spec, ctx);
    const runId = `run_${randomUUID()}`;
    const laneScope = scope.child();
    const policy = ctx.retryPolicy ?? DEFAULT_RETRY_POLICY;

    const makeRun = registryRunFactory(
      ctx.registry,
      (candidate, adapter) => {
        const runSpec: RunSpec = {
          adapterId: candidate.providerId,
          model: candidate.modelId,
          input: spec.input,
          idempotencyKey: spec.idempotencyKey,
          ...(spec.params ? { params: spec.params } : {}),
        };
        const req = specToRequest(runSpec);
        const callCtx: CallContext = {
          signal: laneScope.signal,
          idempotencyKey: spec.idempotencyKey,
          traceId: ctx.turnId,
          runId,
        };
        if (ctx.emit) callCtx.emit = ctx.emit;
        return adapter.stream(req, callCtx);
      },
      laneScope,
      policy,
    );

    const templateSpec: RunSpec = {
      adapterId: candidates[0]?.providerId ?? "",
      model: candidates[0]?.modelId ?? "",
      input: spec.input,
      idempotencyKey: spec.idempotencyKey,
    };
    const builder = makeLaneBuilder(templateSpec, runId);
    let observedAdapter: string | undefined;
    let observedModel: string | undefined;

    const failoverOpts = opts.onFailover ? { onFailover: opts.onFailover } : {};
    const rawSource = stampRunId(runWithFailover(candidates, makeRun, laneScope, failoverOpts), runId);
    const source = traceRunStream(
      rawSource,
      runId,
      templateSpec,
      ctx,
      runSpanKind(ctx, templateSpec.adapterId),
    );
    const labeledStream = ctx.bus.publish(source, { runId, laneIndex: 0 });
    for await (const labeled of labeledStream) {
      if (labeled.chunk.type === "run-start") {
        observedAdapter = labeled.chunk.adapterId;
        observedModel = labeled.chunk.model;
      }
      builder.consume(labeled.chunk);
      await persistAppend(ctx, labeled);
      queue.push(labeled);
    }

    const result = builder.finish(ctx.pricing);
    // The winner is whichever candidate actually answered (failover may switch it).
    if (observedAdapter) result.adapterId = observedAdapter;
    if (observedModel) result.model = observedModel;
    await persistSummaries(ctx, [result]);

    const outcome: OrchestrationOutcome = {
      kind: "single",
      runs: [result],
      usage: sumUsage([result.usage]),
      partial: result.status !== "ok",
    };
    if (result.status === "ok") outcome.winner = result;
    return outcome;
  });
}

// ── Native tool-execution loop (agentic runs) ─────────────────────────────────

/**
 * A pending tool call passed to a {@link ToolInterceptor}'s `preTool` seam.
 */
export interface ToolInterceptRequest {
  /** The tool name the model asked to call. */
  name: string;
  /** The parsed tool input. */
  input: unknown;
}

/**
 * What a {@link ToolInterceptor.preTool} may return to influence a tool call.
 * `block` vetoes the call (its `reason` becomes the tool's error result);
 * `input`, when present, REPLACES the input the tool runs with. Returning
 * nothing (or `void`) is a pure observation and the call proceeds unchanged.
 */
export interface ToolInterceptVerdict {
  block?: boolean;
  reason?: string;
  input?: unknown;
}

/**
 * An additive, dependency-free interception seam for the native tool loop
 * (system-spec §24 hooks). The kernel stays hook-agnostic: a host (CLI / SDK /
 * daemon) bridges its `HookBus`/webhooks into this shape and passes it via
 * {@link AgentOptions.toolInterceptor}. Both callbacks are fully GUARDED by the
 * loop — a throwing interceptor is caught and never breaks (or blocks) a run.
 */
export interface ToolInterceptor {
  /** Fired before a tool executes (after the tool resolves); may veto/rewrite. */
  preTool?(
    req: ToolInterceptRequest,
  ): ToolInterceptVerdict | void | Promise<ToolInterceptVerdict | void>;
  /** Fired after a tool executes, for observation (webhooks / post-tool hooks). */
  postTool?(res: {
    name: string;
    ok: boolean;
    output: unknown;
  }): void | Promise<void>;
}

/** Options controlling an agentic run's tool loop. */
export interface AgentOptions {
  /** The tools the model may call. */
  tools: ToolRegistry;
  /** Approval/sandbox policy enforced before every tool call. */
  gate: PermissionGate;
  /** Hard cap on provider re-invocations (default 8). Prevents infinite loops. */
  maxTurns?: number;
  /** Workspace root handed to filesystem tools (default `process.cwd()`). */
  cwd?: string;
  /** Optional Context Engine; overrides `ctx.contextAssembler` when provided. */
  contextAssembler?: ContextAssembler;
  /**
   * Optional pre/post-tool interception seam (§24 hooks). Additive and
   * hook-agnostic: the loop calls it around every tool execution, guarded so a
   * throwing/blocking interceptor can never crash the run.
   */
  toolInterceptor?: ToolInterceptor;
}

interface ResolvedAgentOptions {
  tools: ToolRegistry;
  gate: PermissionGate;
  maxTurns: number;
  cwd: string;
  contextAssembler: ContextAssembler | undefined;
  toolInterceptor: ToolInterceptor | undefined;
}

/** A tool call the model asked for, normalized from chunks or assistant blocks. */
interface PendingToolCall {
  id: string;
  name: string;
  input: unknown;
}

function toolDefsFrom(registry: ToolRegistry): ToolDef[] {
  return registry.list().map((t) => {
    const def: ToolDef = { name: t.name, parameters: t.parameters };
    if (t.description) def.description = t.description;
    return def;
  });
}

/** Extract `tool_use` blocks from an assistant message (fallback path). */
function toolUseBlocks(message: Message): PendingToolCall[] {
  const out: PendingToolCall[] = [];
  for (const b of message.content) {
    if (b.type === "tool_use") out.push({ id: b.id, name: b.name, input: b.input });
  }
  return out;
}

function cancelledChunk(runId: string): StreamChunk {
  return {
    type: "error",
    runId,
    error: new AdapterError("cancelled", "aborted"),
    retryable: false,
  };
}

/** Run one tool through the gate and normalize the outcome to a ToolResult. */
async function executeToolCall(
  opts: ResolvedAgentOptions,
  call: PendingToolCall,
  scope: CancelScope,
  runId: string,
  traceId: string,
): Promise<ToolResult> {
  let tool: Tool;
  try {
    tool = opts.tools.get(call.name);
  } catch {
    return errText(`no such tool: ${call.name}`);
  }

  // Pre-tool interception (§24 hooks): a host bridge may veto or rewrite the
  // call. Fully guarded — a throwing interceptor is swallowed so it can never
  // crash the run (it neither blocks nor rewrites on failure).
  let input = call.input;
  if (opts.toolInterceptor?.preTool) {
    let verdict: ToolInterceptVerdict | void;
    try {
      verdict = await opts.toolInterceptor.preTool({ name: call.name, input });
    } catch {
      verdict = undefined;
    }
    if (verdict) {
      if (verdict.block === true) {
        return errText(`tool ${call.name} blocked by hook${verdict.reason ? `: ${verdict.reason}` : ""}`);
      }
      if (verdict.input !== undefined) input = verdict.input;
    }
  }

  const decision = await opts.gate.check(tool, input);
  if (!decision.allowed) {
    return errText(`permission denied for ${call.name}: ${decision.reason}`);
  }

  const toolCtx: ToolContext = { signal: scope.signal, cwd: opts.cwd, runId, traceId };
  let result: ToolResult;
  try {
    result = await runTool(tool, input, toolCtx);
  } catch (e) {
    result = errText(`tool ${call.name} failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Post-tool observation (§24 hooks): guarded so a throwing observer is inert.
  if (opts.toolInterceptor?.postTool) {
    try {
      await opts.toolInterceptor.postTool({
        name: call.name,
        ok: !result.isError,
        output: result.content,
      });
    } catch {
      /* isolated: a post-tool observer never affects the run */
    }
  }

  return result;
}

/**
 * Isolate ZLCTS transfer-handle failures: a throwing capture/project/boundary
 * call must never crash the agent run (mirrors the toolInterceptor isolation
 * pattern above). Surfaces the failure on the existing store-error trace
 * channel, prefixed `[transfer]`, so observers see capture gaps without the
 * run sinking. No-op when no handle is attached.
 */
function emitTransferError(ctx: RunContext, e: unknown): void {
  ctx.emit?.({ type: "store-error", traceId: ctx.turnId, ts: Date.now(), data: `[transfer] ${String(e)}` });
}

/**
 * The agentic stream: invoke the provider, and whenever it asks for tools,
 * execute them (through the gate), emit `tool-result` chunks, append the results
 * to the conversation, and re-invoke — looping until the model stops calling
 * tools or `maxTurns` is hit. Intermediate `run-start`/`run-end` chunks are
 * collapsed so the merged stream still has exactly one `run-start` first and one
 * terminal last, per the frozen contract. Honors `scope.signal` throughout.
 */
async function* agentStream(
  run: RunSpec,
  ctx: RunContext,
  opts: ResolvedAgentOptions,
  scope: CancelScope,
  runId: string,
): AsyncIterable<StreamChunk> {
  let adapter: ProviderAdapter;
  try {
    adapter = ctx.registry.get(run.adapterId);
  } catch (e) {
    const err = e instanceof AdapterError ? e : new AdapterError("invalid_request", String(e));
    yield { type: "error", runId, error: err, retryable: err.retryable };
    return;
  }

  let system = run.params?.system;
  let messages: Message[] = [...run.input];
  // ZLCTS capture handle — optional. When present, the runner externalizes
  // every chunk (verbatim + projected), tool output, and turn boundary into the
  // Provider-Neutral Knowledge Core. When absent, behavior is unchanged.
  const transfer = ctx.transfer;

  // Optional context assembly before the first provider call. A failure here is
  // non-fatal: we fall back to the raw messages rather than sink the run.
  if (opts.contextAssembler) {
    try {
      const assembled = await opts.contextAssembler.assemble(
        system !== undefined ? { messages, system } : { messages },
        scope.signal,
      );
      messages = assembled.messages;
      if (assembled.system !== undefined) system = assembled.system;
    } catch (e) {
      ctx.emit?.({ type: "context-error", traceId: ctx.turnId, ts: Date.now(), data: String(e) });
    }
  }

  const toolDefs = toolDefsFrom(opts.tools);
  let emittedRunStart = false;

  // Each provider re-invocation (turn) reports its OWN usage. To avoid
  // undercounting a multi-turn agent run, we accumulate every turn's usage here
  // and emit a single aggregated `usage` chunk (and stamp the aggregate onto the
  // terminal) at the end. Per-turn `usage` chunks are suppressed so the total is
  // reported exactly once — mirroring the single/compare set-semantics, but over
  // the sum of turns rather than one call.
  const turnUsages: Usage[] = [];

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    if (scope.signal.aborted) {
      yield cancelledChunk(runId);
      return;
    }

    // Mark the turn-start boundary in the WAL (best-effort, isolated).
    if (transfer) {
      try {
        await transfer.turnBoundary("start", turn);
      } catch (e) {
        emitTransferError(ctx, e);
      }
    }

    const req: ChatRequest = { model: run.model, messages };
    if (system !== undefined) req.system = system;
    // On the FINAL permitted turn, DROP the tools so the model must summarize
    // what it found into a real text answer instead of requesting yet another
    // tool. This is what turns a "max turns reached" dead-end (tool calls, then
    // silence) into an actual response — the model always gets one turn to answer.
    const lastTurn = turn === opts.maxTurns - 1;
    if (toolDefs.length > 0 && !lastTurn) {
      req.tools = toolDefs;
      req.toolChoice = "auto";
    }
    if (run.params?.maxTokens !== undefined) req.maxTokens = run.params.maxTokens;
    if (run.params?.temperature !== undefined) req.temperature = run.params.temperature;
    if (run.params?.reasoning !== undefined) req.reasoning = run.params.reasoning;

    const callCtx = makeCallContext(runId, run, scope, ctx);

    let heldRunEnd: Extract<StreamChunk, { type: "run-end" }> | undefined;
    let assistantMessage: Message | undefined;
    const openTools = new Map<string, { name: string; args: string }>();
    const turnToolCalls: PendingToolCall[] = [];
    let turnUsageChunk: Partial<Usage> | undefined;
    let errored = false;

    for await (const chunk of adapter.stream(req, callCtx)) {
      const stamped: StreamChunk = chunk.runId === runId ? chunk : ({ ...chunk, runId } as StreamChunk);
      // ZLCTS: capture every adapter chunk verbatim (unredacted, before
      // SessionStore.append redacts) and project it into the PNKC. Both are
      // isolated so a transfer failure never sinks the run.
      if (transfer) {
        try {
          transfer.captureVerbatim(stamped);
        } catch (e) {
          emitTransferError(ctx, e);
        }
        try {
          await transfer.project(stamped);
        } catch (e) {
          emitTransferError(ctx, e);
        }
      }
      switch (stamped.type) {
        case "run-start":
          // Only the very first provider invocation's run-start reaches consumers.
          if (!emittedRunStart) {
            emittedRunStart = true;
            yield stamped;
          }
          break;
        case "run-end":
          // Hold the terminal until we know whether tools continue the loop.
          heldRunEnd = stamped;
          assistantMessage = stamped.message;
          break;
        case "tool-call-start":
          openTools.set(stamped.id, { name: stamped.name, args: "" });
          yield stamped;
          break;
        case "tool-call-delta": {
          const t = openTools.get(stamped.id);
          if (t) t.args += stamped.argsJsonDelta;
          yield stamped;
          break;
        }
        case "tool-call-end":
          turnToolCalls.push({
            id: stamped.id,
            name: openTools.get(stamped.id)?.name ?? "",
            input: stamped.input,
          });
          openTools.delete(stamped.id);
          yield stamped;
          break;
        case "usage":
          // Suppress the per-turn usage chunk; it is folded into the single
          // aggregated usage emitted at the terminal (below).
          turnUsageChunk = stamped.usage;
          break;
        case "error":
          errored = true;
          // Flush what earlier turns accumulated so their tokens aren't lost.
          if (turnUsages.length > 0) yield { type: "usage", runId, usage: sumUsage(turnUsages) };
          yield stamped;
          return;
        default:
          yield stamped;
      }
    }

    if (errored) return;

    // Record this turn's usage (prefer the terminal's figure; fall back to the
    // streamed usage chunk) for the run-wide aggregate. Normalize the possibly
    // partial usage into a full Usage via the shared merge helper.
    const rawTurnUsage = heldRunEnd?.usage ?? turnUsageChunk;
    if (rawTurnUsage) {
      const u: Usage = { inputTokens: 0, outputTokens: 0 };
      mergeUsage(u, rawTurnUsage);
      turnUsages.push(u);
    }

    // Resolve the tool calls: prefer streamed chunks, fall back to the message.
    let calls = turnToolCalls;
    if (calls.length === 0 && assistantMessage) calls = toolUseBlocks(assistantMessage);

    if (calls.length === 0) {
      // No tools requested → the held run-end is the terminal of the whole run.
      // Emit the run-wide aggregated usage once, and stamp it onto the terminal
      // so both the streamed chunk and the lane builder see the full total.
      const total = turnUsages.length > 0 ? sumUsage(turnUsages) : undefined;
      if (total) yield { type: "usage", runId, usage: total };
      if (heldRunEnd) {
        yield total ? { ...heldRunEnd, usage: total } : heldRunEnd;
      } else {
        const end: Extract<StreamChunk, { type: "run-end" }> = {
          type: "run-end",
          runId,
          finishReason: "stop",
          message: assistantMessage ?? { role: "assistant", content: [] },
          ts: Date.now(),
        };
        if (total) end.usage = total;
        yield end;
      }
      // Mark the terminal turn-end boundary (no tools → this turn ends the run).
      if (transfer) {
        try {
          await transfer.turnBoundary("end", turn);
        } catch (e) {
          emitTransferError(ctx, e);
        }
      }
      return;
    }

    // Execute each requested tool and feed the results back into the conversation.
    const toolMessages: Message[] = [];
    for (const call of calls) {
      if (scope.signal.aborted) {
        yield cancelledChunk(runId);
        return;
      }
      const toolKey = `tool:${call.id}`;
      ctx.emit?.(
        spanStart(ctx.turnId, toolKey, {
          name: call.name || "tool",
          kind: "tool",
          runId,
          attributes: { "nexus.tool": call.name || "" },
        }),
      );
      const result = await executeToolCall(opts, call, scope, runId, ctx.turnId);
      // ZLCTS: record the completed tool output for mid-tool-call-termination
      // resume, then capture the runner-synthesized tool-result chunk (it is
      // NOT emitted by the adapter, so the per-chunk hook above misses it).
      if (transfer) {
        try {
          transfer.recordToolOutput(call.name ?? "tool", JSON.stringify(result.content));
        } catch (e) {
          emitTransferError(ctx, e);
        }
      }
      ctx.emit?.(
        spanEnd(ctx.turnId, toolKey, { status: result.isError ? "error" : "ok", runId }),
      );
      const trChunk = toolResultChunk(runId, call.id, result);
      if (transfer) {
        try {
          transfer.captureVerbatim(trChunk);
        } catch (e) {
          emitTransferError(ctx, e);
        }
        try {
          await transfer.project(trChunk);
        } catch (e) {
          emitTransferError(ctx, e);
        }
      }
      yield trChunk;
      const toolMsg: Message = { role: "tool", toolCallId: call.id, content: result.content };
      if (call.name) toolMsg.name = call.name;
      toolMessages.push(toolMsg);
    }

    messages = assistantMessage
      ? [...messages, assistantMessage, ...toolMessages]
      : [...messages, ...toolMessages];
  }

  // maxTurns exhausted while the model still wanted tools → synthesize a clean
  // terminal so consumers always see exactly one terminal chunk. Report the
  // accumulated usage from every completed turn.
  const total = turnUsages.length > 0 ? sumUsage(turnUsages) : undefined;
  if (total) yield { type: "usage", runId, usage: total };
  const end: Extract<StreamChunk, { type: "run-end" }> = {
    type: "run-end",
    runId,
    finishReason: "length",
    message: { role: "assistant", content: [{ type: "text", text: "[agent] max turns reached" }] },
    ts: Date.now(),
  };
  if (total) end.usage = total;
  // Mark the final turn-end boundary (maxTurns exhausted → synthesized terminal).
  if (transfer) {
    try {
      await transfer.turnBoundary("end", opts.maxTurns - 1);
    } catch (e) {
      emitTransferError(ctx, e);
    }
  }
  yield end;
}

/**
 * Dispatch an agentic run: a single provider lane wrapped in the native
 * tool-execution loop. Returns the same `OrchestrationHandle` as `dispatch`, so
 * the CLI/TUI subscribe identically; every tool-call and tool-result flows
 * through the existing bus and `StreamChunk` union.
 */
export function dispatchAgent(run: RunSpec, ctx: RunContext, options: AgentOptions): OrchestrationHandle {
  const scope = ctx.scope.child();
  const queue = new AsyncQueue<Labeled<StreamChunk>>();
  const runId = `run_${randomUUID()}`;
  const builder = makeLaneBuilder(run, runId);

  const opts: ResolvedAgentOptions = {
    tools: options.tools,
    gate: options.gate,
    maxTurns: options.maxTurns ?? 8,
    cwd: options.cwd ?? process.cwd(),
    contextAssembler: options.contextAssembler ?? ctx.contextAssembler,
    toolInterceptor: options.toolInterceptor,
  };

  let resolveOutcome!: (o: OrchestrationOutcome) => void;
  let rejectOutcome!: (e: unknown) => void;
  const outcomePromise = new Promise<OrchestrationOutcome>((res, rej) => {
    resolveOutcome = res;
    rejectOutcome = rej;
  });

  const pump = async (): Promise<void> => {
    const runScope = scope.child();
    // Bracket the agent run as a span; the tool spans emitted inside
    // `agentStream` (through `ctx.emit`) nest under it.
    const rawSource = agentStream(run, ctx, opts, runScope, runId);
    const source = traceRunStream(rawSource, runId, run, ctx, runSpanKind(ctx, run.adapterId));
    const labeledStream = ctx.bus.publish(source, { runId, laneIndex: 0 });

    for await (const labeled of labeledStream) {
      builder.consume(labeled.chunk);
      if (ctx.store) {
        try {
          await ctx.store.append({
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            runId: labeled.runId,
            seq: labeled.seq,
            chunk: labeled.chunk,
          });
        } catch (e) {
          ctx.emit?.({ type: "store-error", traceId: ctx.turnId, ts: Date.now(), data: String(e) });
        }
      }
      queue.push(labeled);
    }

    const result = builder.finish(ctx.pricing);
    if (ctx.store) {
      try {
        await ctx.store.summarize({ ...result, sessionId: ctx.sessionId, turnId: ctx.turnId });
      } catch (e) {
        ctx.emit?.({ type: "store-error", traceId: ctx.turnId, ts: Date.now(), data: String(e) });
      }
    }

    const outcome: OrchestrationOutcome = {
      kind: "single",
      runs: [result],
      winner: result,
      usage: sumUsage([result.usage]),
      partial: result.status !== "ok",
    };
    resolveOutcome(outcome);
    queue.close();
  };

  pump().catch((e: unknown) => {
    rejectOutcome(e);
    queue.fail(e);
  });

  return {
    scope,
    events: () => queue,
    outcome: () => outcomePromise,
  };
}
