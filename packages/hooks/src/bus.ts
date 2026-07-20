/**
 * The `HookBus` — the extensibility seam the harness fires at every lifecycle
 * point (session start/end, pre/post run, pre/post tool, pre/post agent step,
 * error, approval). Handlers are:
 *
 *   - ORDERED   — sorted by `order` (ascending), ties broken by registration
 *                 order, so the merged sequence is deterministic.
 *   - ASYNC     — awaited one after another (a pre-hook that vetoes must resolve
 *                 before the gated operation proceeds); the payload a handler
 *                 modifies is threaded to the next.
 *   - ISOLATED  — a throwing handler is caught, logged, and recorded in
 *                 `outcome.errors`; it NEVER crashes the run and never blocks the
 *                 operation on its own.
 *   - VETO/MODIFY — on the "pre-" events (and `on-approval`) a handler may return
 *                 `{ block, reason, modify, approve }` to deny or rewrite the
 *                 operation; on every other event the verdict is observational.
 *
 * The bus is transport-agnostic: in-process handlers are plain functions;
 * command hooks are adapted into handlers by `./command.ts`.
 */

import {
  HookExecutionError,
  VETOABLE_EVENTS,
  type HookContext,
  type HookError,
  type HookEvent,
  type HookHandler,
  type HookLogger,
  type HookOutcome,
  type HookPayloads,
  type HookVerdict,
  type RegisterOptions,
} from "./types.js";

interface Entry<E extends HookEvent> {
  handler: HookHandler<E>;
  order: number;
  seq: number;
  id?: string;
}

export interface HookBusOptions {
  /** Default logger for isolated handler errors (overridable per `emit`). */
  logger?: HookLogger;
}

/** Type of the verdict a handler for event `E` may return. */
type Verdict<E extends HookEvent> = HookVerdict<HookPayloads[E]>;

function isVerdict<E extends HookEvent>(v: unknown): v is Verdict<E> {
  return typeof v === "object" && v !== null;
}

export class HookBus {
  private readonly entries = new Map<HookEvent, Array<Entry<HookEvent>>>();
  private seqCounter = 0;
  private readonly logger: HookLogger | undefined;

  constructor(opts: HookBusOptions = {}) {
    this.logger = opts.logger;
  }

  /**
   * Register `handler` for `event`. Returns an unregister function (idempotent).
   */
  register<E extends HookEvent>(
    event: E,
    handler: HookHandler<E>,
    opts: RegisterOptions = {},
  ): () => void {
    const list = this.entries.get(event) ?? [];
    const entry: Entry<E> = {
      handler,
      order: opts.order ?? 0,
      seq: this.seqCounter++,
    };
    if (opts.id !== undefined) entry.id = opts.id;
    // Stored covariantly; `emit` only ever invokes it with the matching payload.
    list.push(entry as unknown as Entry<HookEvent>);
    this.entries.set(event, list);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const cur = this.entries.get(event);
      if (!cur) return;
      const i = cur.indexOf(entry as unknown as Entry<HookEvent>);
      if (i >= 0) cur.splice(i, 1);
    };
  }

  /** How many handlers are registered for `event` (test/introspection helper). */
  count(event: HookEvent): number {
    return this.entries.get(event)?.length ?? 0;
  }

  /** Remove every handler for `event` (or all events when omitted). */
  clear(event?: HookEvent): void {
    if (event) this.entries.delete(event);
    else this.entries.clear();
  }

  /**
   * Fire `event` with `payload`. Runs every registered handler in order,
   * awaiting each, threading modifications, isolating errors. Returns the
   * aggregate {@link HookOutcome}. For non-vetoable events `blocked` is always
   * false (verdicts are observational) but `modify` is still applied.
   */
  async emit<E extends HookEvent>(
    event: E,
    payload: HookPayloads[E],
    opts: { signal?: AbortSignal; logger?: HookLogger } = {},
  ): Promise<HookOutcome<HookPayloads[E]>> {
    const list = this.entries.get(event);
    const logger = opts.logger ?? this.logger;
    const errors: HookError[] = [];
    let current = payload;
    let blocked = false;
    let reason: string | undefined;
    let approved: boolean | undefined;
    const vetoable = VETOABLE_EVENTS.has(event);

    if (!list || list.length === 0) {
      const out: HookOutcome<HookPayloads[E]> = { blocked: false, payload: current, errors };
      return out;
    }

    // Order ascending, ties by registration sequence (stable).
    const ordered = [...list].sort((a, b) => a.order - b.order || a.seq - b.seq);

    const ctx: HookContext = { event };
    if (opts.signal) ctx.signal = opts.signal;
    if (logger) ctx.logger = logger;

    for (const entry of ordered) {
      const handler = entry.handler as unknown as HookHandler<E>;
      let verdict: void | Verdict<E>;
      try {
        verdict = await handler(current, ctx);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        const rec: HookError = { event, error };
        if (entry.id !== undefined) rec.id = entry.id;
        errors.push(rec);
        logger?.("error", `hook handler threw on "${event}"`, {
          id: entry.id,
          error: error.message,
        });
        // A hook ADAPTER that failed to EXECUTE (e.g. a command hook whose child
        // couldn't spawn) is a signal, not a handler bug — on a veto-capable event,
        // fail CLOSED by default so a crashed/killed hook can't be used to bypass
        // a security control. A plain thrown `Error` (a bug in handler logic) stays
        // isolated, matching the existing observe-only-on-throw contract.
        if (vetoable && error instanceof HookExecutionError && !error.failOpen) {
          blocked = true;
          approved = false;
          if (reason === undefined) reason = error.message;
        }
        continue; // isolated: a throwing hook never crashes the run or the loop
      }

      if (!isVerdict<E>(verdict)) continue;

      if (verdict.modify && typeof verdict.modify === "object") {
        current = { ...current, ...verdict.modify };
      }

      if (vetoable) {
        if (verdict.block === true) {
          blocked = true;
          approved = false;
          if (reason === undefined) reason = verdict.reason ?? `blocked by hook on "${event}"`;
        }
        if (verdict.approve === false) {
          approved = false;
          if (reason === undefined) reason = verdict.reason ?? `approval denied by hook`;
        } else if (verdict.approve === true && approved === undefined) {
          approved = true;
        }
      }
    }

    const out: HookOutcome<HookPayloads[E]> = { blocked, payload: current, errors };
    if (reason !== undefined) out.reason = reason;
    if (approved !== undefined) out.approved = approved;
    return out;
  }
}

/** Convenience constructor. */
export function createHookBus(opts: HookBusOptions = {}): HookBus {
  return new HookBus(opts);
}
