/**
 * The daemon's run registry. Every started run is a CLIENT of the embedded
 * `Nexus` (which is itself a client of the one engine) — the server keeps only
 * a lightweight record: the id, the originating request shape, the live
 * {@link NexusRun}, and derived status. It never re-implements orchestration.
 */

import { randomUUID } from "node:crypto";
import type { Nexus, NexusRun } from "@nexuscode/sdk";
import type { Backend, ChainStageSpec, NexusSession } from "@nexuscode/sdk";

/** The orchestration primitives a run may target. */
export type RunKind = "single" | "compare" | "race" | "consensus" | "chain" | "agent";

/** Sampling / routing knobs accepted in a run request's `opts`. */
export interface RunOpts {
  provider?: string;
  model?: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
  /** Race mode (`race` only). */
  mode?: "first" | "best";
  /** Agent-loop turn cap (`agent` only). */
  maxTurns?: number;
  /**
   * Permission mode for agentic tool execution (`agent` only). Honored ONLY
   * when the server was started with `allowAgentWrite`; otherwise every agent
   * run is forced through the read-only default gate.
   */
  permissionMode?: "read-only" | "workspace-write" | "full-access" | "plan";
}

/** The JSON body accepted by `POST /v1/runs`. */
export interface RunRequest {
  kind?: RunKind;
  /** Prompt for single/compare/race/consensus. */
  prompt?: string;
  /** Goal for an agent run. */
  goal?: string;
  /** Backends for the multi-lane primitives. */
  providers?: Backend[];
  /** Stages for a chain run. */
  stages?: ChainStageSpec[];
  /** Session selector: `"new"` opens a fresh session, an id resumes one. */
  session?: string;
  opts?: RunOpts;
}

/** A run's terminal or in-flight status. */
export type RunState = "running" | "done" | "error";

/** A stored run record surfaced by `GET /v1/runs/:id`. */
export interface RunRecord {
  id: string;
  kind: RunKind;
  sessionId: string;
  state: RunState;
  createdAt: number;
  error?: string;
  run: NexusRun;
}

/** A session the server has opened, plus the runs launched under it. */
export interface SessionRecord {
  id: string;
  createdAt: number;
  runIds: string[];
}

/** Thrown for a malformed `POST /v1/runs` body (mapped to HTTP 400). */
export class BadRequestError extends Error {}

/** Thrown when the concurrent-run cap is reached (mapped to HTTP 429). */
export class TooManyRunsError extends Error {}

/** Default cap on concurrently `"running"` runs (`POST /v1/runs` beyond it → 429). */
export const DEFAULT_MAX_CONCURRENT_RUNS = 16;

/** Default per-run wall-clock budget (ms) before an abandoned run is cancelled + reaped. */
export const DEFAULT_RUN_TIMEOUT_MS = 15 * 60 * 1000;

/** Concurrency + timeout limits a {@link RunManager} enforces. */
export interface RunManagerLimits {
  /** Max runs allowed in the `"running"` state at once. */
  maxConcurrentRuns: number;
  /** Wall-clock budget (ms) before a still-`"running"` run is cancelled + reaped. */
  runTimeoutMs: number;
}

const DEFAULT_LIMITS: RunManagerLimits = {
  maxConcurrentRuns: DEFAULT_MAX_CONCURRENT_RUNS,
  runTimeoutMs: DEFAULT_RUN_TIMEOUT_MS,
};

function str(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new BadRequestError(`"${field}" must be a non-empty string`);
  }
  return value;
}

function backends(value: unknown): Backend[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BadRequestError(`"providers" must be a non-empty array`);
  }
  for (const b of value) {
    const ok = typeof b === "string" ? b.length > 0 : typeof b === "object" && b !== null && typeof (b as { provider?: unknown }).provider === "string";
    if (!ok) throw new BadRequestError(`each "providers" entry must be a provider id or { provider, model }`);
  }
  return value as Backend[];
}

/**
 * Owns run + session bookkeeping for one embedded `Nexus`. Dispatches a run
 * request onto the matching facade primitive and tracks its lifecycle so the
 * REST surface can list, fetch, and stream it.
 */
export class RunManager {
  private readonly runs = new Map<string, RunRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly limits: RunManagerLimits;

  constructor(
    private readonly nexus: Nexus,
    /** Force agent runs through the read-only default gate unless true. */
    private readonly allowAgentWrite: boolean,
    limits: Partial<RunManagerLimits> = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    // The always-present default session is visible from the first request.
    this.ensureSession(nexus.session.id);
  }

  /** Count of runs currently in the `"running"` state (used against the concurrency cap). */
  activeRunCount(): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.state === "running") n++;
    return n;
  }

  private ensureSession(id: string): SessionRecord {
    let rec = this.sessions.get(id);
    if (!rec) {
      rec = { id, createdAt: Date.now(), runIds: [] };
      this.sessions.set(id, rec);
    }
    return rec;
  }

  private async resolveSession(selector: string | undefined): Promise<NexusSession> {
    if (selector === undefined || selector === "" || selector === this.nexus.session.id) {
      return this.nexus.session;
    }
    if (selector === "new") {
      const s = await this.nexus.openSession();
      this.ensureSession(s.id);
      return s;
    }
    const s = await this.nexus.resumeSession(selector);
    this.ensureSession(s.id);
    return s;
  }

  private sampling(opts: RunOpts): { system?: string; maxTokens?: number; temperature?: number } {
    const out: { system?: string; maxTokens?: number; temperature?: number } = {};
    if (typeof opts.system === "string") out.system = opts.system;
    if (typeof opts.maxTokens === "number") out.maxTokens = opts.maxTokens;
    if (typeof opts.temperature === "number") out.temperature = opts.temperature;
    return out;
  }

  /** Dispatch a run request and register the resulting run. */
  async start(body: RunRequest): Promise<RunRecord> {
    // Resource-exhaustion guard: refuse a new run once too many are already
    // in flight, BEFORE dispatching anything, rather than letting an unbounded
    // number of concurrent runs (each holding provider connections + buffered
    // event streams) exhaust the process.
    if (this.activeRunCount() >= this.limits.maxConcurrentRuns) {
      throw new TooManyRunsError(
        `too many concurrent runs (limit ${this.limits.maxConcurrentRuns}); retry once one completes`,
      );
    }

    const kind: RunKind = body.kind ?? "single";
    const opts = body.opts ?? {};
    const session = await this.resolveSession(body.session);
    const sampling = this.sampling(opts);
    const provider = typeof opts.provider === "string" ? opts.provider : undefined;
    const model = typeof opts.model === "string" ? opts.model : undefined;

    let run: NexusRun;
    switch (kind) {
      case "single": {
        const askOpts: Parameters<Nexus["ask"]>[1] = { ...sampling, session };
        if (provider !== undefined) askOpts.provider = provider;
        if (model !== undefined) askOpts.model = model;
        run = this.nexus.ask(str(body.prompt, "prompt"), askOpts);
        break;
      }
      case "compare":
        run = this.nexus.compare(str(body.prompt, "prompt"), backends(body.providers), { ...sampling, session });
        break;
      case "race": {
        const raceOpts: Parameters<Nexus["race"]>[2] = { ...sampling, session };
        if (opts.mode === "first" || opts.mode === "best") raceOpts.mode = opts.mode;
        run = this.nexus.race(str(body.prompt, "prompt"), backends(body.providers), raceOpts);
        break;
      }
      case "consensus":
        run = this.nexus.consensus(str(body.prompt, "prompt"), backends(body.providers), { ...sampling, session });
        break;
      case "chain": {
        if (!Array.isArray(body.stages) || body.stages.length === 0) {
          throw new BadRequestError(`"stages" must be a non-empty array for a chain run`);
        }
        const chainOpts: Parameters<Nexus["chain"]>[1] = { ...sampling, session };
        if (provider !== undefined) chainOpts.provider = provider;
        if (model !== undefined) chainOpts.model = model;
        run = this.nexus.chain(body.stages, chainOpts);
        break;
      }
      case "agent": {
        const agentOpts: Parameters<Nexus["agent"]>[1] = { ...sampling, session };
        if (provider !== undefined) agentOpts.provider = provider;
        if (model !== undefined) agentOpts.model = model;
        if (typeof opts.maxTurns === "number") agentOpts.maxTurns = opts.maxTurns;
        // Security: agent tool execution is gated by the PermissionGate. Callers
        // may only request a stronger mode when the daemon explicitly allows it;
        // otherwise the run falls through to the Nexus read-only default gate.
        if (this.allowAgentWrite && opts.permissionMode !== undefined) {
          agentOpts.permissionMode = opts.permissionMode;
        }
        run = this.nexus.agent(str(body.goal, "goal"), agentOpts);
        break;
      }
      default:
        throw new BadRequestError(`unknown run kind "${String(kind)}"`);
    }

    const id = randomUUID();
    const record: RunRecord = {
      id,
      kind,
      sessionId: session.id,
      state: "running",
      createdAt: Date.now(),
      run,
    };
    this.runs.set(id, record);
    this.ensureSession(session.id).runIds.push(id);

    // Wall-clock reaper: an abandoned/stuck run (e.g. a hung provider call, or a
    // client that started a run and never streamed/cancelled it) must not hold a
    // concurrency slot forever. Cancel it once it overruns the budget; the
    // outcome settling below (via `run.cancel`'s abort) then reaps the slot.
    const timeoutMs = this.limits.runTimeoutMs;
    const timeoutTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (record.state === "running") void run.cancel("timeout").catch(() => {});
          }, timeoutMs)
        : undefined;
    timeoutTimer?.unref?.();

    // Track terminal state off the settled outcome without consuming the
    // replayable event stream the SSE endpoint needs.
    void run
      .outcome()
      .then(() => {
        if (record.state === "running") record.state = "done";
      })
      .catch((err: unknown) => {
        record.state = "error";
        record.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
      });

    return record;
  }

  get(id: string): RunRecord | undefined {
    return this.runs.get(id);
  }

  listRuns(): Array<Omit<RunRecord, "run">> {
    return [...this.runs.values()].map(({ run: _run, ...rest }) => rest);
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()];
  }

  getSession(id: string): SessionRecord | undefined {
    return this.sessions.get(id);
  }
}
