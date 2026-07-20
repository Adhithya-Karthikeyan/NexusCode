/**
 * ProcessManager — background job control for the terminal subsystem
 * (system-spec §13: parallel execution · streaming output · interrupt · env).
 *
 * A job is a `child_process.spawn`ed process, tracked by id. The manager can
 * list jobs, expose their output (both a live async-iterable stream AND a
 * buffered snapshot), enforce the same combined-output byte cap as `shell_exec`,
 * kill a job (SIGTERM escalating to SIGKILL, then reap), and report exit status.
 *
 * Safety invariants mirror `shell_exec`:
 *   - NEVER `shell: true`; command + args are an argv array (no injection).
 *   - The child's base env is `scrubSecretEnv(process.env)` before `spec.env`
 *     is merged on top, so provider API keys never leak into a spawned process.
 *   - Combined stdout+stderr is capped; on overflow the child is SIGTERMed and
 *     flagged `outputCapped` instead of buffering without bound.
 *   - Cancellation via an optional `AbortSignal` kills the job immediately.
 *   - A configurable ceiling on LIVE concurrent jobs (`maxConcurrentJobs`,
 *     default 8) — `spawn()` REFUSES (throws) rather than launch a fork-bomb of
 *     long-lived background processes; completed/killed jobs free a slot.
 *   - A per-job wall-clock timeout (`maxRuntimeMs`, default 10 min) — a job
 *     that outruns it is SIGTERMed (escalating to SIGKILL after the grace
 *     period, same as the output cap) and reaped, so nothing runs forever.
 *   - The job's cwd is confined to the configured workspace root
 *     (symlink-aware, via `resolveInWorkspaceSync` — the same guard `fs_read`/
 *     `fs_write`/`shell_exec` use), rejecting an escaping cwd before the child
 *     is ever spawned.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { NexusError } from "@nexuscode/shared";
import { scrubSecretEnv, DEFAULT_MAX_OUTPUT_BYTES } from "../shell.js";
import { resolveInWorkspaceSync } from "../paths.js";
import { AsyncBroadcast } from "./async-broadcast.js";

/** Default ceiling on LIVE (running) background jobs a single manager tracks. */
export const DEFAULT_MAX_CONCURRENT_JOBS = 8;

/** Default per-job wall-clock timeout before SIGTERM→SIGKILL (10 minutes). */
export const DEFAULT_MAX_JOB_RUNTIME_MS = 10 * 60 * 1000;

/** Which stream an output chunk arrived on. */
export type OutputStream = "stdout" | "stderr";

/** One incremental chunk of a job's output, in arrival order. */
export interface OutputChunk {
  stream: OutputStream;
  data: string;
}

/** Lifecycle state of a tracked job. */
export type JobStatus = "running" | "exited" | "killed" | "error";

/** How to launch a background job. */
export interface JobSpec {
  /** Executable to run (no shell interpretation). */
  command: string;
  /** Argument vector (no shell interpretation). */
  args?: string[];
  /** Working directory (defaults to the manager's cwd, else `process.cwd()`). */
  cwd?: string;
  /** Extra env merged over a secret-scrubbed `process.env`. */
  env?: Record<string, string>;
  /** Combined stdout+stderr byte cap before the child is killed. */
  maxOutputBytes?: number;
  /** Wall-clock timeout before the job is SIGTERMed→SIGKILLed (default 10 min). */
  maxRuntimeMs?: number;
  /** Abort to kill the job (SIGTERM→SIGKILL). */
  signal?: AbortSignal;
}

/** A serializable snapshot of a job's current state. */
export interface JobInfo {
  id: string;
  command: string;
  args: string[];
  pid: number | undefined;
  status: JobStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt: number | undefined;
  outputBytes: number;
  outputCapped: boolean;
  /** True once the job was killed for exceeding `maxRuntimeMs`. */
  timedOut: boolean;
  error: string | undefined;
}

/** Options for `ProcessManager` construction. */
export interface ProcessManagerOptions {
  /** Default working directory for jobs (defaults to `process.cwd()`). */
  cwd?: string;
  /**
   * Workspace root every job's cwd is confined to (symlink-aware — same guard
   * `fs_read`/`fs_write`/`shell_exec` use). Defaults to `cwd` if given, else
   * `process.cwd()`.
   */
  workspaceRoot?: string;
  /** Default combined-output byte cap (defaults to shell's 8 MiB). */
  maxOutputBytes?: number;
  /** Grace period between SIGTERM and SIGKILL on `kill()` (default 2000ms). */
  killGraceMs?: number;
  /** Ceiling on LIVE (running) jobs; `spawn()` refuses past it (default 8). */
  maxConcurrentJobs?: number;
  /** Default per-job wall-clock timeout (default 10 min = 600_000ms). */
  maxRuntimeMs?: number;
}

/**
 * A single tracked background job. Constructed by `ProcessManager.spawn`. Holds
 * the child, its buffered output, and a replayable broadcast for streaming.
 */
export class Job {
  readonly id: string;
  readonly command: string;
  readonly args: string[];
  readonly startedAt: number;

  private readonly child: ChildProcess;
  private readonly broadcast = new AsyncBroadcast<OutputChunk>();
  private readonly maxOutputBytes: number;
  private readonly maxRuntimeMs: number;
  private readonly killGraceMs: number;

  private stdoutBuf = "";
  private stderrBuf = "";
  private combinedBuf = "";
  private outputBytes = 0;
  private outputCapped = false;
  private timedOut = false;

  private status: JobStatus = "running";
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private endedAt: number | undefined;
  private spawnError: Error | undefined;
  private settled = false;

  /** Shared SIGTERM→SIGKILL escalation timer for both the output cap and the runtime timeout. */
  private killEscalationTimer: NodeJS.Timeout | undefined;
  private runTimer: NodeJS.Timeout | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort: () => void;

  /** Resolves (never rejects) when the child has closed and been reaped. */
  readonly exited: Promise<JobInfo>;
  private resolveExited!: (info: JobInfo) => void;

  constructor(
    spec: JobSpec,
    defaults: Required<Pick<ProcessManagerOptions, "cwd" | "maxOutputBytes" | "killGraceMs" | "maxRuntimeMs">>,
  ) {
    this.id = randomUUID();
    this.command = spec.command;
    this.args = spec.args ? [...spec.args] : [];
    this.startedAt = Date.now();
    this.maxOutputBytes = spec.maxOutputBytes ?? defaults.maxOutputBytes;
    this.maxRuntimeMs = spec.maxRuntimeMs ?? defaults.maxRuntimeMs;
    this.killGraceMs = defaults.killGraceMs;
    this.signal = spec.signal;

    this.exited = new Promise<JobInfo>((resolve) => {
      this.resolveExited = resolve;
    });

    const baseEnv = scrubSecretEnv(process.env);
    this.child = spawn(this.command, this.args, {
      cwd: spec.cwd ?? defaults.cwd,
      env: spec.env ? { ...baseEnv, ...spec.env } : baseEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child.stdout?.on("data", (d: Buffer) => this.onData("stdout", d));
    this.child.stderr?.on("data", (d: Buffer) => this.onData("stderr", d));
    this.child.on("error", (err: Error) => {
      this.spawnError = err;
      this.status = "error";
      this.settle();
    });
    this.child.on("close", (code: number | null, sig: NodeJS.Signals | null) => {
      this.exitCode = code;
      this.exitSignal = sig;
      if (this.status === "running") {
        this.status = sig !== null ? "killed" : "exited";
      }
      this.settle();
    });

    this.onAbort = (): void => {
      void this.kill("SIGTERM");
    };
    if (this.signal) {
      if (this.signal.aborted) this.onAbort();
      else this.signal.addEventListener("abort", this.onAbort, { once: true });
    }

    // FIX B: per-job wall-clock timeout. SIGTERM at maxRuntimeMs, escalating to
    // SIGKILL after the same kill-grace period used elsewhere, then reaped via
    // the ordinary `close` handler above — never left an orphan.
    this.runTimer = setTimeout(() => this.onRuntimeExceeded(), this.maxRuntimeMs);
    this.runTimer.unref?.();
  }

  private onRuntimeExceeded(): void {
    if (this.settled || this.timedOut) return;
    this.timedOut = true;
    this.status = "killed";
    this.child.kill("SIGTERM");
    this.killEscalationTimer = setTimeout(() => {
      if (!this.settled) this.child.kill("SIGKILL");
    }, this.killGraceMs);
    this.killEscalationTimer.unref?.();
  }

  private onData(stream: OutputStream, d: Buffer): void {
    if (this.outputCapped || this.timedOut || this.settled) return;
    const s = d.toString("utf8");
    if (stream === "stdout") this.stdoutBuf += s;
    else this.stderrBuf += s;
    this.combinedBuf += s;
    this.outputBytes += Buffer.byteLength(s, "utf8");
    this.broadcast.push({ stream, data: s });
    if (this.outputBytes > this.maxOutputBytes) {
      this.outputCapped = true;
      this.status = "killed";
      this.child.kill("SIGTERM");
      this.killEscalationTimer = setTimeout(() => {
        if (!this.settled) this.child.kill("SIGKILL");
      }, this.killGraceMs);
      this.killEscalationTimer.unref?.();
    }
  }

  private settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.endedAt = Date.now();
    if (this.killEscalationTimer) clearTimeout(this.killEscalationTimer);
    if (this.runTimer) clearTimeout(this.runTimer);
    if (this.signal) this.signal.removeEventListener("abort", this.onAbort);
    this.broadcast.close();
    this.resolveExited(this.info());
  }

  /** True while the child is still running. */
  get running(): boolean {
    return !this.settled;
  }

  /** Live + replayed streaming output as an async-iterable of chunks. */
  stream(): AsyncIterable<OutputChunk> {
    return { [Symbol.asyncIterator]: () => this.broadcast.iterate() };
  }

  /** Buffered combined output (stdout+stderr) in arrival order. */
  output(): string {
    return this.combinedBuf;
  }

  /** Buffered stdout only. */
  stdout(): string {
    return this.stdoutBuf;
  }

  /** Buffered stderr only. */
  stderr(): string {
    return this.stderrBuf;
  }

  /** A snapshot of current state. */
  info(): JobInfo {
    return {
      id: this.id,
      command: this.command,
      args: [...this.args],
      pid: this.child.pid,
      status: this.status,
      exitCode: this.exitCode,
      signal: this.exitSignal,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      outputBytes: this.outputBytes,
      outputCapped: this.outputCapped,
      timedOut: this.timedOut,
      error: this.spawnError?.message,
    };
  }

  /**
   * Signal the child, escalating to SIGKILL after the grace period if it does
   * not exit, then wait for it to be reaped. Resolves with the final snapshot.
   * Idempotent — a no-op on an already-exited job.
   */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<JobInfo> {
    if (this.settled) return this.info();
    if (this.status === "running") this.status = "killed";
    this.child.kill(signal);
    const killTimer = setTimeout(() => {
      if (!this.settled) this.child.kill("SIGKILL");
    }, this.killGraceMs);
    killTimer.unref?.();
    const info = await this.exited;
    clearTimeout(killTimer);
    return info;
  }

  /** Wait for the job to exit and return its final snapshot. */
  wait(): Promise<JobInfo> {
    return this.exited;
  }
}

/**
 * Tracks a set of background `Job`s by id: spawn, list, look up, and kill.
 */
export class ProcessManager {
  private readonly jobs = new Map<string, Job>();
  private readonly defaults: Required<
    Pick<ProcessManagerOptions, "cwd" | "maxOutputBytes" | "killGraceMs" | "maxRuntimeMs">
  >;
  /** Workspace root every job's cwd is confined to (FIX C). */
  private readonly workspaceRoot: string;
  /** Ceiling on LIVE (running) jobs (FIX A). */
  private readonly maxConcurrentJobs: number;

  constructor(opts: ProcessManagerOptions = {}) {
    const cwd = opts.cwd ?? process.cwd();
    this.defaults = {
      cwd,
      maxOutputBytes: opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      killGraceMs: opts.killGraceMs ?? 2000,
      maxRuntimeMs: opts.maxRuntimeMs ?? DEFAULT_MAX_JOB_RUNTIME_MS,
    };
    this.workspaceRoot = opts.workspaceRoot ?? cwd;
    this.maxConcurrentJobs = opts.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS;
  }

  /**
   * Spawn and track a background job.
   *
   * FIX A (resource exhaustion): refuses — throws `NexusError("invalid_argument")`
   * — rather than spawn once `maxConcurrentJobs` LIVE (running) jobs are already
   * tracked; completed/killed jobs free a slot and don't count toward the cap.
   *
   * FIX C (workspace escape): the job's cwd is resolved against `workspaceRoot`
   * and confined to it (symlink-aware, same guard as `fs_read`/`fs_write`/
   * `shell_exec`) — an escaping cwd is rejected before the child is ever spawned.
   */
  spawn(spec: JobSpec): Job {
    const liveCount = [...this.jobs.values()].filter((j) => j.running).length;
    if (liveCount >= this.maxConcurrentJobs) {
      throw new NexusError(
        "invalid_argument",
        `max concurrent background jobs (${this.maxConcurrentJobs}) reached — kill a job first`,
      );
    }

    const cwd = resolveInWorkspaceSync(this.workspaceRoot, spec.cwd ?? this.defaults.cwd);

    const job = new Job({ ...spec, cwd }, this.defaults);
    this.jobs.set(job.id, job);
    return job;
  }

  /** Look up a tracked job by id. */
  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Snapshots of every tracked job, in insertion order. */
  list(): JobInfo[] {
    return [...this.jobs.values()].map((j) => j.info());
  }

  /** Only the jobs still running. */
  listRunning(): JobInfo[] {
    return this.list().filter((j) => j.status === "running");
  }

  /** Kill a tracked job by id (SIGTERM→SIGKILL, reap). Returns its snapshot. */
  async kill(id: string, signal: NodeJS.Signals = "SIGTERM"): Promise<JobInfo | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    return job.kill(signal);
  }

  /** Kill every running job and wait for all to be reaped. */
  async killAll(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    await Promise.all([...this.jobs.values()].filter((j) => j.running).map((j) => j.kill(signal)));
  }

  /** Drop a job from tracking (does not kill it). */
  remove(id: string): boolean {
    return this.jobs.delete(id);
  }

  /** Remove every already-exited job from tracking; returns how many were pruned. */
  prune(): number {
    let n = 0;
    for (const [id, job] of this.jobs) {
      if (!job.running) {
        this.jobs.delete(id);
        n++;
      }
    }
    return n;
  }
}
