/**
 * JobRegistry — cross-invocation record of BACKGROUNDED jobs (`nexus jobs run
 * --background`), fixing GAPS G4: `ProcessManager` (`@nexuscode/tools`) only
 * tracks jobs for the lifetime of the process that spawned them, so a plain
 * `jobs run` (foreground: streams to completion, then the process exits) never
 * needed cross-invocation state. `--background` changes that — the child is
 * meant to outlive the CLI invocation that launched it — so something durable
 * has to answer `jobs list` / `jobs logs <id>` / `jobs kill <id>` from a LATER,
 * unrelated invocation. This is that something: one JSON file under the data
 * dir (`jobs.json`, same convention as `@nexuscode/tasks`' `tasks.json`),
 * written atomically (temp file + rename, 0600 perms).
 *
 * A record is not enough on its own to safely act on later, though: pids get
 * reused by the OS once a process exits, and blindly signaling "the process at
 * this pid" has already killed an unrelated `claude` process on this box once
 * (broad pid/process matching, no identity check). So:
 *   - `list()` / `getProbed()` RE-PROBE actual OS state on every read — a dead
 *     or reassigned pid is reported as `"gone"`, never left showing `"running"`
 *     forever just because nothing else ever updated the file.
 *   - `killJob()` re-verifies identity (recorded command name + OS-reported
 *     process start time, both via `ps`) immediately before sending a signal,
 *     and refuses outright — never signals — if either fails to match.
 *
 * The actual background execution is a self-relaunch: `launchBackgroundJob`
 * spawns `process.execPath` running the SAME CLI entry with an env marker
 * (`NEXUS_JOB_CHILD_ID`), detached and `unref()`d (identical idiom to
 * `runIndexInBackground` in `commands.ts`). That re-launched process is what
 * calls `runDetachedJob`: it spawns the REAL command with stdio redirected
 * straight to a log file (no pipes to drain, so nothing needs to keep polling
 * it), records the job, and stays alive — independent of the original
 * invocation's process tree — until the real command exits, then writes the
 * final status. `cmdJobs` in `commands.ts` only wires subcommands to this
 * module; the mechanism lives here.
 */

import { spawn as nodeSpawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { nexusPaths } from "@nexuscode/config";
import { scrubSecretEnv } from "@nexuscode/tools";

/** Env marker stamped on the re-launched detached worker: "you ARE the
 * background job's keeper for this id — spawn the real command and wait for
 * it, don't fork again." Absence is what makes `--background` fork in the
 * first place, exactly like `NEXUS_INDEX_CHILD_ENV` for `index --background`. */
export const NEXUS_JOB_CHILD_ENV = "NEXUS_JOB_CHILD_ID";

export type JobRecordStatus = "running" | "exited" | "killed" | "error" | "gone";

/** One backgrounded job, as persisted to `jobs.json`. */
export interface JobRecord {
  id: string;
  /** pid of the REAL command (not the detached Node wrapper that launched it). */
  pid: number;
  command: string;
  args: string[];
  cwd: string;
  /** Absolute path to the captured combined stdout+stderr log. */
  logFile: string;
  startedAt: number;
  status: JobRecordStatus;
  exitCode: number | null;
  signal: string | null;
  endedAt: number | null;
}

interface RegistryFileShape {
  version: 1;
  jobs: JobRecord[];
}

function jobsDataDir(): string {
  return process.env["NEXUS_DATA_DIR"] ?? nexusPaths().data;
}

/** The JSON file the job registry persists to. */
export function jobsRegistryFile(): string {
  return join(jobsDataDir(), "jobs.json");
}

/** Directory captured background-job logs live under (`<id>.log` each). */
export function jobsLogDir(): string {
  return join(jobsDataDir(), "job-logs");
}

/** True while `pid` refers to SOME live process (existence only, not identity). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists but we can't signal it — still alive. Anything
    // else (ESRCH: no such process) means it is not.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One `ps -o <field>=` column for `pid`, or undefined if `ps` found nothing. */
function psField(pid: number, field: string): string | undefined {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", `${field}=`], {
      encoding: "utf8",
      timeout: 2000,
    }).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined; // no such pid, or `ps` unavailable — never trusted as a match
  }
}

const IDENTITY_TIME_TOLERANCE_MS = 2 * 60 * 1000;

function baseName(p: string): string {
  return p.split("/").pop() ?? p;
}

/**
 * Does the live process at `record.pid` still look like the one we recorded?
 * Required for anything destructive (killing) and used to decide whether a
 * `"running"` record is still trustworthy on read. Both the command name AND
 * the OS-reported process start time (`ps -o lstart=`) must line up within a
 * tolerance — command name alone is not enough backing for sending a signal,
 * since an unrelated process can share a short/common command name.
 */
export function verifyIdentity(record: JobRecord): boolean {
  const comm = psField(record.pid, "comm");
  if (comm === undefined) return false;
  if (baseName(comm) !== baseName(record.command)) return false;

  const lstart = psField(record.pid, "lstart");
  if (lstart === undefined) return false;
  const started = Date.parse(lstart);
  if (Number.isNaN(started)) return true; // command matched; timing unparseable — don't veto on that alone
  return Math.abs(started - record.startedAt) <= IDENTITY_TIME_TOLERANCE_MS;
}

/** Re-probed view of one record: a stale `"running"` record whose process is
 * gone or no longer matches is reported `"gone"` rather than left `"running"`
 * forever — the exact failure `jobs list` used to have (an empty list forever,
 * this is the same shape of bug one level down: a status nobody updates). */
function reprobe(rec: JobRecord): JobRecord {
  if (rec.status !== "running") return rec; // already terminal — the writer's word is final
  if (!isAlive(rec.pid) || !verifyIdentity(rec)) {
    return { ...rec, status: "gone", endedAt: rec.endedAt ?? Date.now() };
  }
  return rec;
}

/** The durable job registry. One JSON file, read fully and rewritten atomically. */
export class JobRegistry {
  private readonly filePath: string;

  constructor(filePath: string = jobsRegistryFile()) {
    this.filePath = filePath;
  }

  private readAll(): JobRecord[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as RegistryFileShape;
      return Array.isArray(parsed?.jobs) ? parsed.jobs : [];
    } catch {
      return []; // corrupt/unreadable file: behave as an empty registry rather than crash
    }
  }

  private writeAll(jobs: JobRecord[]): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const data: RegistryFileShape = { version: 1, jobs };
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* best-effort on platforms without POSIX perms */
    }
  }

  /** Append a new record. */
  record(rec: JobRecord): void {
    const jobs = this.readAll();
    jobs.push(rec);
    this.writeAll(jobs);
  }

  /** Patch a record's mutable (post-launch) fields in place. No-op if the id is unknown. */
  update(
    id: string,
    patch: Partial<Pick<JobRecord, "status" | "exitCode" | "signal" | "endedAt" | "pid">>,
  ): void {
    const jobs = this.readAll();
    const idx = jobs.findIndex((j) => j.id === id);
    if (idx === -1) return;
    jobs[idx] = { ...(jobs[idx] as JobRecord), ...patch };
    this.writeAll(jobs);
  }

  /** Raw record by id — NOT re-probed (used where the caller re-probes itself, e.g. `killJob`). */
  get(id: string): JobRecord | undefined {
    return this.readAll().find((j) => j.id === id);
  }

  /** Record by id with liveness re-probed against the real OS process table. */
  getProbed(id: string): JobRecord | undefined {
    const rec = this.get(id);
    return rec ? reprobe(rec) : undefined;
  }

  /** Every record, oldest-first, liveness re-probed. This is what `jobs list` reads. */
  list(): JobRecord[] {
    return this.readAll().map(reprobe);
  }
}

export type KillOutcome =
  | { ok: true; record: JobRecord }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "not-running"; record: JobRecord }
  | { ok: false; reason: "identity-mismatch"; record: JobRecord };

/**
 * Kill a backgrounded job by id: SIGTERM, escalating to SIGKILL after
 * `graceMs` if it hasn't exited. Re-verifies process identity (see
 * {@link verifyIdentity}) immediately before EVERY signal sent — never signals
 * a pid it cannot positively confirm is still the recorded job, which is the
 * one hard safety rule here (see the file header for why).
 */
export async function killJob(
  id: string,
  registry: JobRegistry,
  opts: { signal?: NodeJS.Signals; graceMs?: number } = {},
): Promise<KillOutcome> {
  const rec = registry.get(id);
  if (!rec) return { ok: false, reason: "not-found" };
  if (rec.status !== "running") return { ok: false, reason: "not-running", record: rec };

  if (!isAlive(rec.pid)) {
    registry.update(id, { status: "gone", endedAt: Date.now() });
    return { ok: false, reason: "not-running", record: { ...rec, status: "gone" } };
  }
  if (!verifyIdentity(rec)) {
    // NEVER signal here — this is exactly the failure mode that killed an
    // unrelated process on this box before. Report and stop.
    return { ok: false, reason: "identity-mismatch", record: rec };
  }

  const signal = opts.signal ?? "SIGTERM";
  const graceMs = opts.graceMs ?? 2000;
  try {
    process.kill(rec.pid, signal);
  } catch {
    /* gone between the check above and now — treat as a clean stop below */
  }
  await new Promise((r) => setTimeout(r, graceMs));
  if (isAlive(rec.pid) && verifyIdentity(rec)) {
    try {
      process.kill(rec.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  const endedAt = Date.now();
  registry.update(id, { status: "killed", signal, endedAt });
  return { ok: true, record: { ...rec, status: "killed", signal, endedAt } };
}

/**
 * Entry point for the RE-LAUNCHED detached worker (see file header): spawn the
 * real command with stdio redirected to a log file, record it, and resolve
 * only once the command has exited (having written the final status first).
 * This call is meant to occupy the detached process for the job's entire
 * lifetime — it is what keeps that process (and therefore the job) alive
 * independent of the original `jobs run --background` invocation.
 */
export function runDetachedJob(opts: {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  registry?: JobRegistry;
}): Promise<void> {
  const registry = opts.registry ?? new JobRegistry();
  const logDir = jobsLogDir();
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logFile = join(logDir, `${opts.id}.log`);
  const fd = openSync(logFile, "a", 0o600);

  return new Promise((resolveJob) => {
    const child = nodeSpawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: scrubSecretEnv(process.env),
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd); // the child holds its own duplicated fd; ours is no longer needed

    registry.record({
      id: opts.id,
      pid: child.pid ?? -1,
      command: opts.command,
      args: opts.args,
      cwd: opts.cwd,
      logFile,
      startedAt: Date.now(),
      status: "running",
      exitCode: null,
      signal: null,
      endedAt: null,
    });

    const finish = (status: JobRecordStatus, exitCode: number | null, signal: string | null): void => {
      registry.update(opts.id, { status, exitCode, signal, endedAt: Date.now() });
      resolveJob();
    };
    child.on("close", (code, sig) => finish(sig !== null ? "killed" : "exited", code, sig));
    child.on("error", () => finish("error", null, null));
  });
}

/** Injectable spawn signature for {@link launchBackgroundJob} (tests). */
export type BackgroundSpawnLike = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: "ignore"; env: NodeJS.ProcessEnv },
) => ChildProcess | { pid?: number | undefined; unref(): void };

/**
 * Launch `command` as a detached background job: fork `process.execPath`
 * running THIS SAME CLI entry (re-invoking `jobs run` with the original argv,
 * `NEXUS_JOB_CHILD_ID` set) so the child calls straight into
 * {@link runDetachedJob}, then `unref()` so the launching process can exit
 * immediately. Polls (bounded) for the job's registry record to appear before
 * returning, so a caller can rely on `jobs list` seeing it right away rather
 * than racing the fork.
 */
export async function launchBackgroundJob(opts: {
  command: string;
  args: string[];
  cwd: string;
  registry?: JobRegistry;
  spawn?: BackgroundSpawnLike;
}): Promise<{ id: string; record: JobRecord | undefined }> {
  const id = `job_${randomUUID()}`;
  const registry = opts.registry ?? new JobRegistry();
  const spawnFn = opts.spawn ?? nodeSpawn;
  const entry = process.argv[1];
  if (!entry) {
    throw new Error("nexus jobs run --background: cannot resolve the CLI entry to re-launch");
  }

  const childArgs = [entry, "jobs", "run", "--cwd", opts.cwd, "--", opts.command, ...opts.args];
  const child = spawnFn(process.execPath, childArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [NEXUS_JOB_CHILD_ENV]: id },
  });
  child.unref();

  // Bounded poll for the registry record so `jobs list` right after this call
  // reliably sees the job — the fork + first write typically lands in well
  // under 100ms, but this never blocks longer than the timeout either way.
  const deadline = Date.now() + 3000;
  let record = registry.get(id);
  while (!record && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
    record = registry.get(id);
  }
  return { id, record };
}
