/**
 * The engine ties the registry, bus, pricing, and persistence into the
 * session → turn → run lifecycle. A `Session` is the durable, resumable
 * container; a `Turn` is one user intent; `Turn.context()` produces the
 * `RunContext` that `dispatch` consumes.
 */

import { randomUUID } from "node:crypto";
import { userText, type Message } from "@nexuscode/shared";
import type { Bus } from "./bus.js";
import { createBus } from "./bus.js";
import { CancelScope, rootScope } from "./cancel.js";
import type { RetryPolicy } from "./resilience.js";
import type { ProviderRegistry } from "./registry.js";
import type { TraceEvent } from "./adapter.js";
import type { ContextAssembler, EventStore, PricingTable, RunContext } from "./types.js";

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
}

export interface TurnInput {
  prompt?: string;
  messages?: Message[];
  system?: string;
}

export interface Turn {
  readonly id: string;
  readonly sessionId: string;
  readonly input: Message[];
  readonly scope: CancelScope;
  /** Build the RunContext dispatched orchestrations consume. */
  context(): RunContext;
}

export interface OpenSessionOptions {
  /** Resume an existing session id (history replay lands with the store). */
  resume?: string;
  /** Explicit new session id (default: generated). */
  id?: string;
}

export interface Session {
  readonly id: string;
  readonly scope: CancelScope;
  newTurn(input: TurnInput): Turn;
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

    const session: Session = {
      id,
      scope: sessionScope,
      newTurn(input: TurnInput): Turn {
        const turnId = `t_${randomUUID()}`;
        const turnScope = sessionScope.child();
        const messages = toMessages(input);
        return {
          id: turnId,
          sessionId: id,
          input: messages,
          scope: turnScope,
          context(): RunContext {
            const ctx: RunContext = {
              sessionId: id,
              turnId,
              registry: engine.registry,
              bus: engine.bus,
              scope: turnScope,
            };
            if (engine.config.pricing) ctx.pricing = engine.config.pricing;
            if (engine.config.store) ctx.store = engine.config.store;
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
