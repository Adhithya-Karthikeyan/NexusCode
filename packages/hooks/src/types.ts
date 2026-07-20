/**
 * Hook + webhook contract types (system-spec §24 Extensibility). Kept
 * structural and dependency-light: the payloads mirror the relevant subset of
 * the kernel's run/tool/agent objects by SHAPE so `@nexuscode/hooks` never
 * build-couples to `@nexuscode/core`. The host (CLI / SDK / daemon) constructs
 * these payloads at each lifecycle point from its live engine objects.
 */

/** The ten lifecycle events a hook (or webhook) can subscribe to. */
export type HookEvent =
  | "session-start"
  | "session-end"
  | "pre-run"
  | "post-run"
  | "pre-tool"
  | "post-tool"
  | "pre-agent-step"
  | "post-agent-step"
  | "on-error"
  | "on-approval";

/**
 * The events where a hook may VETO or MODIFY: the "pre-" gate points plus the
 * approval decision. Every other event is observe-only — a returned verdict's
 * `block`/`modify`/`approve` is ignored by the bus (but the handler still runs,
 * so it can react to `post-*` / `on-error`).
 */
export const VETOABLE_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  "pre-run",
  "pre-tool",
  "pre-agent-step",
  "on-approval",
]);

/** Per-event payload shapes. Additive-only; keep in sync with the host wiring. */
export interface HookPayloads {
  "session-start": { sessionId: string; ts: number; meta?: Record<string, unknown> };
  "session-end": { sessionId: string; ts: number; meta?: Record<string, unknown> };
  "pre-run": {
    sessionId: string;
    turnId: string;
    runId?: string;
    adapterId: string;
    model: string;
    input?: unknown;
  };
  "post-run": {
    sessionId: string;
    turnId: string;
    runId: string;
    status: string;
    text?: string;
    usage?: unknown;
  };
  "pre-tool": {
    toolName: string;
    input: unknown;
    permission?: string;
    sessionId?: string;
    runId?: string;
  };
  "post-tool": {
    toolName: string;
    ok: boolean;
    output?: unknown;
    sessionId?: string;
    runId?: string;
  };
  "pre-agent-step": { sessionId?: string; step: number; role?: string; goal?: string };
  "post-agent-step": { sessionId?: string; step: number; role?: string; status?: string };
  "on-error": { message: string; code?: string; where?: string; sessionId?: string };
  "on-approval": {
    toolName: string;
    permission: string;
    mode?: string;
    input?: unknown;
    sessionId?: string;
  };
}

/**
 * What a hook handler may return to influence a lifecycle point. All fields are
 * optional; returning nothing (or a non-object) is a pure observation.
 *
 * - `block: true` VETOES the operation (only honored on {@link VETOABLE_EVENTS}).
 * - `modify` shallow-merges into the payload and is threaded to later hooks and
 *   back to the caller (so a `pre-tool` hook can rewrite the tool `input`).
 * - `approve` is the explicit yes/no for `on-approval`; `false` denies.
 */
export interface HookVerdict<T = unknown> {
  block?: boolean;
  reason?: string;
  modify?: Partial<T>;
  approve?: boolean;
}

/** Context handed to every handler alongside its typed payload. */
export interface HookContext {
  event: HookEvent;
  /** Aborts a slow/blocking handler (command hooks honor it). */
  signal?: AbortSignal;
  /** Structured logger for isolated-handler errors. No-op by default. */
  logger?: HookLogger;
}

export type HookLogger = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
) => void;

/** A single hook handler for event `E`. Async or sync; may return a verdict. */
export type HookHandler<E extends HookEvent> = (
  payload: HookPayloads[E],
  ctx: HookContext,
) =>
  | void
  | HookVerdict<HookPayloads[E]>
  | Promise<void | HookVerdict<HookPayloads[E]>>;

/** Options at registration time. */
export interface RegisterOptions {
  /** Lower runs first (default 0). Ties broken by registration order (stable). */
  order?: number;
  /** Optional id surfaced in error logs / outcome. */
  id?: string;
}

/** One isolated handler failure captured during an emit (never re-thrown). */
export interface HookError {
  id?: string;
  event: HookEvent;
  error: Error;
}

/**
 * Signal thrown by a hook ADAPTER (e.g. a command hook whose child process
 * failed to spawn/execute) when the hook itself could not run — distinct from a
 * bug in handler logic (a plain thrown `Error`). On a {@link VETOABLE_EVENTS}
 * event the bus treats this as a DENY by default (fail-closed): a hook that
 * crashed/couldn't execute must not thereby let the gated operation through.
 * Set `failOpen: true` (per-hook) to opt out; observe-only events ignore this
 * either way since they can't veto.
 */
export class HookExecutionError extends Error {
  readonly failOpen: boolean;
  constructor(message: string, opts: { failOpen?: boolean } = {}) {
    super(message);
    this.name = "HookExecutionError";
    this.failOpen = opts.failOpen ?? false;
  }
}

/** The aggregate result of emitting one event through the bus. */
export interface HookOutcome<T> {
  /** True if any handler vetoed a {@link VETOABLE_EVENTS} event. */
  blocked: boolean;
  /** First block reason (or approval-denied reason). */
  reason?: string;
  /** The final, possibly-modified payload (threaded through every handler). */
  payload: T;
  /**
   * For `on-approval`: the resolved decision. `undefined` when no handler
   * expressed one. A `block:true` or `approve:false` resolves it to `false`.
   */
  approved?: boolean;
  /** Isolated handler failures (a throwing hook never crashes the run). */
  errors: HookError[];
}
