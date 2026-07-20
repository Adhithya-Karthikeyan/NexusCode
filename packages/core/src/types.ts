/**
 * The run / session / stream model and orchestration types. Every primitive is
 * defined purely over `Run` objects and their `StreamChunk` streams — that is
 * what makes chat providers and wrapped coding CLIs interchangeable.
 */

import type {
  AdapterError,
  Message,
  Pricing,
  StreamChunk,
  Usage,
  FinishReason,
} from "@nexuscode/shared";
import type { Bus, Labeled } from "./bus.js";
import type { CancelScope } from "./cancel.js";
import type { RetryPolicy } from "./resilience.js";
import type { ProviderRegistry } from "./registry.js";
import type { TraceEvent } from "./adapter.js";

export interface SamplingParams {
  maxTokens?: number;
  temperature?: number;
  system?: string;
  reasoning?: { enabled: boolean; budgetTokens?: number; effort?: "low" | "medium" | "high" };
}

export interface RunSpec {
  adapterId: string;
  /** Logical model id (resolved to native by the adapter/registry). */
  model: string;
  input: Message[];
  params?: SamplingParams;
  idempotencyKey: string;
  timeoutMs?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface UnifiedDiff {
  path: string;
  patch: string;
  status: "proposed" | "applied" | "cancelled";
}

export type RunStatus = "ok" | "error" | "cancelled" | "timeout";

export interface RunResult {
  runId: string;
  adapterId: string;
  model: string;
  status: RunStatus;
  text: string;
  toolCalls: ToolCall[];
  diffs: UnifiedDiff[];
  usage: Usage;
  finishReason?: FinishReason;
  error?: AdapterError;
}

export interface Run {
  readonly id: string;
  readonly spec: RunSpec;
  /** One adapter.stream() under a leaf CancelScope. */
  stream(scope: CancelScope): AsyncIterable<StreamChunk>;
}

// ── Orchestration ─────────────────────────────────────────────────────────────

export interface Score {
  runId: string;
  score: number;
  rationale?: string;
}

export interface MergedResult {
  text?: string;
  diff?: UnifiedDiff[];
  pickedFrom?: RunResult;
  rationale: string;
  scores: Score[];
}

export interface JudgeSpec {
  domain: "chat" | "code";
  model?: string;
  adapterId?: string;
  rubric?: Record<string, number>;
  /** How the judge reduces candidates to one answer. Default varies by primitive. */
  strategy?: "rank" | "vote" | "merge";
  /** Number of independent judge passes for `strategy: "vote"` (default 3). */
  votes?: number;
}

/**
 * One `Judge` interface, two implementations selected by `JudgeSpec.domain`
 * (chat rubric vs grounded diff). `rank` picks a winner; `merge` produces a
 * (possibly synthesized) reconciling answer; `vote` runs K independent judge
 * passes and picks the candidate with the majority of #1 placements (tie-break
 * varies by domain — see the concrete judges); `judgeResults` exposes the
 * judge's own provider runs for usage accounting.
 */
export interface Judge {
  rank(cands: RunResult[], ctx: RunContext): Promise<{ winner: RunResult; scores: Score[] }>;
  merge(cands: RunResult[], ctx: RunContext): Promise<MergedResult>;
  vote(cands: RunResult[], ctx: RunContext): Promise<{ winner: RunResult; scores: Score[] }>;
  judgeResults(): RunResult[];
}

export interface ChainStage {
  name: string;
  run: RunSpec;
  optional?: boolean;
  gate?: "auto" | "confirm";
  /**
   * Build this stage's input from the previous stage's result (the hand-off).
   * Stage 0 has no predecessor and uses `run.input` directly. When omitted on a
   * later stage, the previous result's text is appended to `run.input`.
   */
  handoff?: (prev: RunResult) => Message[];
}

export type OrchestrationSpec =
  | { kind: "single"; run: RunSpec }
  | { kind: "compare"; runs: RunSpec[] }
  | { kind: "race"; runs: RunSpec[]; mode: "first" | "best"; judge?: JudgeSpec }
  | { kind: "consensus"; runs: RunSpec[]; judge: JudgeSpec }
  | { kind: "chain"; stages: ChainStage[] };

export type OrchestrationKind = OrchestrationSpec["kind"];

export interface OrchestrationOutcome {
  kind: OrchestrationKind;
  runs: RunResult[];
  winner?: RunResult;
  merged?: MergedResult;
  usage: Usage;
  /** True if any lane failed (primitives settle, never short-circuit). */
  partial: boolean;
}

export interface OrchestrationHandle {
  /** The TUI/CLI subscribes here for live labeled chunks. */
  events(): AsyncIterable<Labeled<StreamChunk>>;
  /** Resolves once every lane settles. */
  outcome(): Promise<OrchestrationOutcome>;
  scope: CancelScope;
}

/** Table of `logical model id → Pricing`, built from config. */
export type PricingTable = Record<string, Pricing>;

/**
 * Append-only persistence seam. The SQLite implementation lands with the CLI;
 * core only depends on this interface so it stays storage-agnostic.
 */
export interface EventStore {
  append(entry: {
    sessionId: string;
    turnId: string;
    runId: string;
    seq: number;
    chunk: StreamChunk;
  }): void | Promise<void>;
  summarize(result: RunResult & { sessionId: string; turnId: string }): void | Promise<void>;
}

/** The model-ready request an assembler produces from a raw turn input. */
export interface AssembledContext {
  /** Cache-stable system prefix; when omitted the caller's own system is used. */
  system?: string;
  /** History + volatile context + the query, ready to send to the provider. */
  messages: Message[];
}

/**
 * The Context Engine seam, injectable into the engine/agent loop. An assembler
 * transforms a raw turn (its messages + optional system) into the model-ready
 * request. Kept structural so `@nexuscode/core` never build-couples to
 * `@nexuscode/context`; the CLI adapts a real `ContextEngine` to this shape.
 */
export interface ContextAssembler {
  assemble(
    input: { messages: Message[]; system?: string },
    signal: AbortSignal,
  ): Promise<AssembledContext>;
}

/** Everything a dispatched orchestration needs, produced by `Turn.context()`. */
export interface RunContext {
  sessionId: string;
  turnId: string;
  registry: ProviderRegistry;
  bus: Bus;
  scope: CancelScope;
  pricing?: PricingTable;
  store?: EventStore;
  retryPolicy?: RetryPolicy;
  emit?: (e: TraceEvent) => void;
  /** Optional Context Engine run before the first provider dispatch. */
  contextAssembler?: ContextAssembler;
}
