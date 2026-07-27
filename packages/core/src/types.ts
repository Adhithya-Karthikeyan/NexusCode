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
import type {
  ProviderCircuitBreaker,
  ProviderCircuitTarget,
} from "./provider-circuit.js";
import type { RouteCandidate } from "./router.js";
import type {
  ProviderSwitchReceipt,
  ProviderSwitchRuntimeOptions,
} from "./switching.js";
import type {
  MutationRecoveryApproval,
  PartialRecoveryTrackerOptions,
} from "./partial-recovery.js";

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
  /**
   * The full intra-run tool-use exchange, carried over from the terminal
   * `run-end` chunk's `toolExchange` (see `@nexuscode/shared`'s `StreamChunk`
   * doc). Only populated for an agentic run that actually looped through
   * tool calls; a caller building conversation history from a `RunResult`
   * should prefer this over synthesizing a single message from `text`.
   */
  toolExchange?: Message[];
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

  /**
   * OPTIONAL durable transcript seam — what makes a conversation resumable in a
   * LATER process. Everything else here is provider OUTPUT; this is the only
   * place the user's own messages are persisted, so a store may legitimately
   * refuse to implement it (or implement it as a no-op when the user has not
   * opted in). Called once per turn with that turn's NEW messages, and again
   * with the assistant's reply; re-calling with the same `seq` REPLACES it.
   */
  appendTranscript?(entry: {
    sessionId: string;
    turnId: string;
    seq: number;
    messages: Message[];
  }): void | Promise<void>;

  /**
   * OPTIONAL counterpart: the stored conversation for a session, oldest first.
   * An empty array means "nothing stored" — which callers must report honestly
   * rather than presenting as a resumed conversation.
   */
  loadTranscript?(sessionId: string): Message[] | Promise<Message[]>;
  /** Last successful provider/model for an explicitly resumed session. */
  loadLastProvider?(
    sessionId: string,
  ):
    | { providerId: string; modelId: string }
    | undefined
    | Promise<{ providerId: string; modelId: string } | undefined>;
  /** Provider-native session ids, kept in independent provider slots. */
  loadProviderSessions?(
    sessionId: string,
  ): Record<string, string> | Promise<Record<string, string>>;
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

/**
 * The ZLCTS capture seam. When attached to a {@link RunContext}, the agent
 * runner externalizes every chunk, tool output, and turn boundary into the
 * Provider-Neutral Knowledge Core so a mid-run provider switch loses nothing.
 *
 * Structural: `@nexuscode/transfer`'s `createTransferHandle` returns an object
 * that satisfies this shape, so core and the transfer package do not
 * build-couple. Every method is best-effort and MUST be isolated by the caller:
 * a throwing handle never crashes the run. When `undefined`, the runner
 * captures nothing and behaves exactly as before.
 */
export interface TransferHandle {
  readonly sessionId: string;
  /** Capture a raw, unredacted chunk BEFORE the redacting SessionStore.append. */
  captureVerbatim(chunk: StreamChunk): void;
  /** Project a chunk to typed deltas and fold them into the PNKC (WAL + items). */
  project(chunk: StreamChunk): Promise<void>;
  /** Record a completed tool's output for mid-tool-call-termination resume. */
  recordToolOutput(tool: string, stdout: string): void;
  /** Emit a turn-boundary lifecycle marker into the WAL. */
  turnBoundary(kind: "start" | "end", turn: number): Promise<void>;
  /** Durability barrier: mark the WAL durably written up to the high-water lamport. */
  flush(): void;
}

/** Identity of one concrete provider run handed to a transfer factory. */
export interface TransferRunIdentity {
  sessionId: string;
  turnId: string;
  runId: string;
}

/**
 * Lazily create one transfer handle per provider run. Concurrent orchestration
 * lanes need independent projector state while sharing the same durable store.
 */
export type TransferHandleFactory = (identity: TransferRunIdentity) => TransferHandle | undefined;

/** Provider-neutral facts available when constructing a switch handoff capsule. */
export interface ProviderHandoffBuildInput {
  sessionId: string;
  turnId: string;
  fromProviderId: string;
  fromModelId: string;
  toProviderId: string;
  toModelId: string;
  error: AdapterError;
  attempt: number;
  messages: Message[];
  system?: string;
}

/**
 * Structural seam implemented by `@nexuscode/transfer`. Core never imports the
 * concrete capsule implementation; it only appends the returned system message
 * to the next provider request.
 */
export type ProviderHandoffBuilder = (input: ProviderHandoffBuildInput) => Message | undefined;

export interface ProviderActionGuardInput {
  sessionId: string;
  turnId: string;
  actionId: string;
  name: string;
  input: unknown;
  permission: "read" | "write" | "exec" | "network";
}

export interface ProviderActionGuardDecision {
  blocked: boolean;
  reason?: string;
}

/** Harness-owned duplicate-effect gate applied before the ordinary permission gate. */
export type ProviderActionGuard = (
  input: ProviderActionGuardInput,
) => ProviderActionGuardDecision | Promise<ProviderActionGuardDecision>;

/** Opt-in runtime policy for recovering a response after useful text streamed. */
export interface PartialRecoveryRuntimeOptions extends PartialRecoveryTrackerOptions {
  mutationApproval?: MutationRecoveryApproval;
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
  /** Optional ZLCTS capture handle; when set, the runner externalizes the run. */
  transfer?: TransferHandle;
  /** Optional run-local ZLCTS handle factory used by every dispatch primitive. */
  transferFactory?: TransferHandleFactory;
  /** Persistent provider/account/model availability state. */
  providerCircuit?: ProviderCircuitBreaker;
  /** Adds stable credential/account identity to circuit scopes without exposing secrets. */
  circuitTargetFor?: (candidate: RouteCandidate) => ProviderCircuitTarget;
  /** Structured handoff capsule renderer used during provider failover. */
  handoffBuilder?: ProviderHandoffBuilder;
  /** Disabled unless explicitly configured; permits safe text-only continuation. */
  partialRecovery?: PartialRecoveryRuntimeOptions;
  /** Last successful backend in this live session, used for explicit switches. */
  previousProvider?: { providerId: string; modelId: string };
  /** Universal provider-switch policy shared by direct, routed, and agent runs. */
  switching?: ProviderSwitchRuntimeOptions;
  /** Blocks replay of completed/partial actions reconstructed at a handoff. */
  actionGuard?: ProviderActionGuard;
  /** Most recent switch receipt, exposed to hosts that want an inline summary. */
  lastSwitchReceipt?: ProviderSwitchReceipt;
  /** Provider-native session slots restored for this Nexus session. */
  providerSessions?: Readonly<Record<string, string>>;
}
