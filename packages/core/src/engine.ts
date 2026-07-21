/**
 * The engine ties the registry, bus, pricing, and persistence into the
 * session → turn → run lifecycle. A `Session` is the durable, resumable
 * container; a `Turn` is one user intent; `Turn.context()` produces the
 * `RunContext` that `dispatch` consumes.
 *
 * A `Session` also owns the CONVERSATION TRANSCRIPT — the short-term memory that
 * makes the harness remember. Every turn is dispatched with the prior turns
 * (user lines + assistant replies) ahead of the new input, and each turn's reply
 * is recorded back into the session. Without this, turn N+1 is an isolated
 * prompt and the harness has amnesia everywhere outside the TUI.
 *
 * Two invariants keep it honest:
 *  - EXACTLY ONCE. A caller that already threads its own history (the TUI passes
 *    `[...prior, ...newLine]`) is detected and NOT re-prefixed, so history is
 *    never duplicated.
 *  - BOUNDED. The transcript is trimmed to a token budget, oldest turns first,
 *    so unbounded memory can never turn into a hard context-limit failure. The
 *    current turn's own input and any `system` messages are never dropped.
 */

import { randomUUID } from "node:crypto";
import { estimateTokens } from "@nexuscode/memory";
import { userText, type ContentBlock, type Message } from "@nexuscode/shared";
import type { Bus } from "./bus.js";
import { createBus } from "./bus.js";
import { CancelScope, rootScope } from "./cancel.js";
import type { RetryPolicy } from "./resilience.js";
import type { ProviderRegistry } from "./registry.js";
import type { TraceEvent } from "./adapter.js";
import type {
  ContextAssembler,
  EventStore,
  OrchestrationOutcome,
  PricingTable,
  RunContext,
  RunResult,
} from "./types.js";

/**
 * Default transcript budget, in estimated tokens. Deliberately well under a
 * modern context window: history is only ONE of the things competing for the
 * window (system prompt, tools, retrieved context, the answer itself).
 */
export const DEFAULT_HISTORY_MAX_TOKENS = 32_000;

/** Conversation-memory knobs. Memory is ON by default — a harness must remember. */
export interface HistoryOptions {
  /** `false` makes every turn an isolated prompt (opt-out). Default `true`. */
  enabled?: boolean;
  /** Token budget for the threaded transcript. Default {@link DEFAULT_HISTORY_MAX_TOKENS}. */
  maxTokens?: number;
}

export interface EngineConfig {
  registry: ProviderRegistry;
  /** Defaults to a fresh in-process bus. */
  bus?: Bus;
  pricing?: PricingTable;
  store?: EventStore;
  retryPolicy?: RetryPolicy;
  emit?: (e: TraceEvent) => void;
  /** Optional Context Engine, run by the agent loop before the first dispatch. */
  contextAssembler?: ContextAssembler;
  /** Conversation-memory defaults for every session opened on this engine. */
  history?: HistoryOptions;
}

export interface TurnInput {
  prompt?: string;
  messages?: Message[];
  system?: string;
}

/** Anything a caller can hand {@link Turn.record} as "this turn's reply". */
export type TurnReply = string | Message[] | RunResult | OrchestrationOutcome | undefined;

export interface Turn {
  readonly id: string;
  readonly sessionId: string;
  readonly input: Message[];
  readonly scope: CancelScope;
  /** Build the RunContext dispatched orchestrations consume. */
  context(): RunContext;
  /**
   * Record this turn's assistant reply into the session transcript, so the NEXT
   * turn sees it. Calling it twice REPLACES the recorded reply rather than
   * appending a second one — an explicit `record(outcome)` (winner-aware) always
   * supersedes the automatic capture that happens when the run settles.
   */
  record(reply: TurnReply): void;
}

export interface OpenSessionOptions {
  /** Resume an existing session id (history replay lands with the store). */
  resume?: string;
  /** Explicit new session id (default: generated). */
  id?: string;
  /** Per-session conversation-memory overrides (merged over the engine's). */
  history?: HistoryOptions;
}

export interface Session {
  readonly id: string;
  readonly scope: CancelScope;
  /** The accumulated conversation so far, oldest → newest. Already bounded. */
  readonly transcript: readonly Message[];
  newTurn(input: TurnInput): Turn;
  /** Seed or replace the transcript (e.g. after replaying a resumed session). */
  setTranscript(messages: readonly Message[]): void;
  /** Cancel every in-flight turn under this session. */
  dispose(): Promise<void>;
}

export interface Engine {
  readonly registry: ProviderRegistry;
  readonly bus: Bus;
  openSession(opts?: OpenSessionOptions): Promise<Session>;
  dispose(): Promise<void>;
}

function toMessages(input: TurnInput): Message[] {
  const msgs: Message[] = [];
  if (input.messages) msgs.push(...input.messages);
  else if (input.prompt !== undefined) msgs.push(...userText(input.prompt));
  return msgs;
}

// ── Transcript (short-term conversation memory) ───────────────────────────────

/** Rough token cost of one content block (same char/4 estimator the Context Engine uses). */
function blockTokens(block: ContentBlock): number {
  switch (block.type) {
    case "text":
    case "thinking":
      return estimateTokens(block.text);
    case "tool_use":
      return estimateTokens(block.name) + estimateTokens(JSON.stringify(block.input ?? null));
    case "tool_result":
      return block.content.reduce((sum, b) => sum + blockTokens(b), 0);
    default:
      // Binary payloads (image/audio) are opaque to a text estimator; charge a
      // flat, deliberately pessimistic cost so they still push the budget.
      return 512;
  }
}

/** Rough token cost of one message, including a small per-message framing cost. */
export function messageTokens(message: Message): number {
  let total = 4;
  for (const block of message.content) total += blockTokens(block);
  return total;
}

function messageKey(message: Message): string {
  return JSON.stringify(message);
}

/**
 * If `incoming` already contains `history` as an ordered subsequence, the caller
 * threaded the conversation itself (the TUI does). Returns the index in
 * `incoming` just past the last matched history message — everything after it is
 * this turn's NEW input. Returns `undefined` when the history is absent, i.e.
 * the engine must prepend it.
 */
function threadedAt(incoming: readonly Message[], history: readonly Message[]): number | undefined {
  if (history.length === 0) return 0;
  if (incoming.length < history.length) return undefined;
  const keys = history.map(messageKey);
  let matched = 0;
  for (let i = 0; i < incoming.length; i++) {
    if (messageKey(incoming[i]!) === keys[matched]) {
      matched++;
      if (matched === history.length) return i + 1;
    }
  }
  return undefined;
}

/**
 * Trim `messages` to `maxTokens`, dropping the OLDEST first. The last `keepTail`
 * messages (this turn's own input) and every `system` message are never dropped.
 * Leading `assistant`/`tool` messages orphaned by the trim are removed too, so
 * the surviving history still opens on a user turn (providers such as Anthropic
 * reject a transcript that starts mid-exchange).
 */
export function boundTranscript(
  messages: readonly Message[],
  maxTokens: number,
  keepTail = 0,
): Message[] {
  if (messages.length === 0) return [];
  const tailStart = Math.max(0, messages.length - Math.max(0, keepTail));
  const tail = messages.slice(tailStart);
  const head = messages.slice(0, tailStart);

  let total = tail.reduce((sum, m) => sum + messageTokens(m), 0);
  const kept: Message[] = [];
  let full = maxTokens <= 0;
  for (let i = head.length - 1; i >= 0; i--) {
    const m = head[i]!;
    const cost = messageTokens(m);
    if (m.role === "system") {
      kept.unshift(m); // the system prompt survives every trim
      total += cost;
      continue;
    }
    if (full || total + cost > maxTokens) {
      full = true; // keep scanning: older `system` messages still get preserved
      continue;
    }
    total += cost;
    kept.unshift(m);
  }
  while (kept.length > 0 && (kept[0]!.role === "assistant" || kept[0]!.role === "tool")) {
    kept.shift();
  }
  return [...kept, ...tail];
}

/**
 * Trim a REHYDRATED transcript to complete exchanges: drop trailing `user`/`tool`
 * messages whose reply was never recorded (the process died, the run errored).
 * Resuming onto an unanswered user turn would append a second user message back
 * to back, which providers requiring strict role alternation reject outright —
 * and the dangling question was never answered anyway, so replaying it as
 * "history" would misrepresent the conversation.
 */
function resumable(messages: readonly Message[]): Message[] {
  const out = [...messages];
  while (out.length > 0 && out[out.length - 1]!.role !== "assistant") out.pop();
  return out;
}

/** Normalize whatever a caller recorded into the assistant messages to append. */
function replyMessages(reply: TurnReply): Message[] {
  if (reply === undefined) return [];
  if (typeof reply === "string") {
    return reply.length > 0 ? [{ role: "assistant", content: [{ type: "text", text: reply }] }] : [];
  }
  if (Array.isArray(reply)) return reply;
  const result: RunResult | undefined = "runId" in reply ? reply : (reply.winner ?? reply.runs[0]);
  if (!result || result.status !== "ok" || result.text.length === 0) return [];
  return [{ role: "assistant", content: [{ type: "text", text: result.text }] }];
}

class EngineImpl implements Engine {
  readonly registry: ProviderRegistry;
  readonly bus: Bus;
  private readonly config: EngineConfig;
  private readonly rootCancel: CancelScope;

  constructor(config: EngineConfig) {
    this.config = config;
    this.registry = config.registry;
    this.bus = config.bus ?? createBus();
    this.rootCancel = rootScope();
  }

  async openSession(opts: OpenSessionOptions = {}): Promise<Session> {
    const id = opts.resume ?? opts.id ?? `s_${randomUUID()}`;
    const sessionScope = this.rootCancel.child();
    const engine = this;

    const history: HistoryOptions = { ...this.config.history, ...opts.history };
    const remembers = history.enabled ?? true;
    const maxTokens = history.maxTokens ?? DEFAULT_HISTORY_MAX_TOKENS;

    /** The live transcript. Mutated in place so every turn's closures see it. */
    const transcript: Message[] = [];
    const setAll = (messages: readonly Message[]): void => {
      transcript.length = 0;
      transcript.push(...messages);
    };

    // Durable-transcript sequence. After a resume it restarts at the MESSAGE
    // count, which is always >= the number of stored sequence groups — so a
    // resumed session's new turns can never overwrite its stored ones. It may
    // leave gaps in `seq`; that is harmless, since `seq` only orders rows.
    let seq = 0;
    const persist = (turnId: string, at: number, messages: readonly Message[]): void => {
      if (!remembers || messages.length === 0) return;
      try {
        const written = this.config.store?.appendTranscript?.({
          sessionId: id,
          turnId,
          seq: at,
          messages: [...messages],
        });
        // Best-effort, exactly like every other store call: a persistence failure
        // must never sink a live conversation.
        if (written instanceof Promise) written.catch(() => {});
      } catch {
        /* ignore */
      }
    };

    // Resume: rehydrate the stored conversation before the first turn. The bound
    // is the SAME one live turns use, so resuming a 500-turn session cannot blow
    // the context window.
    if (opts.resume !== undefined && remembers) {
      try {
        const loaded = await this.config.store?.loadTranscript?.(id);
        if (loaded && loaded.length > 0) {
          setAll(boundTranscript(resumable(loaded), maxTokens, 1));
          seq = loaded.length;
        }
      } catch {
        /* a store that cannot read degrades to a fresh session, never a crash */
      }
    }

    const session: Session = {
      id,
      scope: sessionScope,
      get transcript(): readonly Message[] {
        return transcript;
      },
      setTranscript(messages: readonly Message[]): void {
        setAll(remembers ? boundTranscript(messages, maxTokens, 1) : messages);
      },
      newTurn(input: TurnInput): Turn {
        const turnId = `t_${randomUUID()}`;
        const turnScope = sessionScope.child();
        const incoming = toMessages(input);

        // Thread the prior conversation ahead of the new input — unless the
        // caller already did it itself, in which case history stays exactly once.
        let messages = incoming;
        const turnSeq = seq;
        if (remembers) {
          const at = threadedAt(incoming, transcript);
          const combined = at === undefined ? [...transcript, ...incoming] : incoming;
          const fresh = at === undefined ? incoming.length : incoming.length - at;
          messages = boundTranscript(combined, maxTokens, fresh);
          setAll(messages);
          // Persist only this turn's NEW messages (never the re-threaded history),
          // so the durable transcript grows linearly, not quadratically.
          persist(turnId, turnSeq, messages.slice(messages.length - fresh));
          seq = turnSeq + 2; // [turnSeq] = this turn's input, [turnSeq+1] = its reply
        }

        // This turn's reply slot. Both the automatic capture below and an
        // explicit `record(...)` write here, so the transcript gains exactly one
        // assistant message per turn no matter how many lanes settled.
        let recorded: Message[] = [];
        const recordReply = (reply: Message[]): void => {
          if (!remembers || reply.length === 0) return;
          for (const m of recorded) {
            const i = transcript.indexOf(m);
            if (i >= 0) transcript.splice(i, 1);
          }
          recorded = reply;
          transcript.push(...reply);
          setAll(boundTranscript(transcript, maxTokens, 1));
          // Same seq every time, so a later explicit `record(...)` REPLACES the
          // auto-captured reply on disk instead of appending a second one.
          persist(turnId, turnSeq + 1, reply);
        };

        // Persistence seam + automatic reply capture. The orchestrator summarizes
        // every settled run through `ctx.store`, which is where a turn learns what
        // the model actually answered without the caller having to tell it.
        const base = engine.config.store;
        const store: EventStore = {
          append: (entry) => base?.append(entry),
          summarize: (result) => {
            recordReply(replyMessages(result));
            return base?.summarize(result);
          },
        };

        return {
          id: turnId,
          sessionId: id,
          input: messages,
          scope: turnScope,
          record(reply: TurnReply): void {
            recordReply(replyMessages(reply));
          },
          context(): RunContext {
            const ctx: RunContext = {
              sessionId: id,
              turnId,
              registry: engine.registry,
              bus: engine.bus,
              scope: turnScope,
            };
            if (engine.config.pricing) ctx.pricing = engine.config.pricing;
            if (remembers) ctx.store = store;
            else if (base) ctx.store = base;
            if (engine.config.retryPolicy) ctx.retryPolicy = engine.config.retryPolicy;
            if (engine.config.emit) ctx.emit = engine.config.emit;
            if (engine.config.contextAssembler) ctx.contextAssembler = engine.config.contextAssembler;
            return ctx;
          },
        };
      },
      async dispose(): Promise<void> {
        await sessionScope.cancel("user");
      },
    };
    return session;
  }

  async dispose(): Promise<void> {
    await this.rootCancel.cancel("user");
    await this.registry.disposeAll();
  }
}

export function createEngine(config: EngineConfig): Engine {
  return new EngineImpl(config);
}
