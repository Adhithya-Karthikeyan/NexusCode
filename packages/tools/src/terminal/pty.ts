/**
 * Interactive shell / PTY seam (system-spec §13). Defines a provider-agnostic
 * `Pty` interface and ships TWO implementations:
 *
 *   1. `ChildProcessPty` — the ALWAYS-AVAILABLE default. A line-oriented
 *      `child_process.spawn` with piped stdio. It is not a true TTY (no kernel
 *      echo, no window size), but it fully drives interactive-style programs
 *      that read stdin and write stdout/stderr, and it streams raw bytes so
 *      ANSI escape sequences pass through untouched.
 *
 *   2. A node-pty-backed implementation loaded LAZILY via optional dynamic
 *      import (`loadNodePty`). It is used ONLY if `node-pty` is installed;
 *      `node-pty` is NOT a hard dependency and its absence never fails a build
 *      or test — `createPty` transparently falls back to `ChildProcessPty`.
 *
 * Env is scrubbed with `scrubSecretEnv`; commands are argv arrays (no shell
 * injection).
 *
 * FIX C (workspace escape): both backends confine a spawned session's `cwd` to
 * a configured workspace root (symlink-aware, via `resolveInWorkspaceSync` —
 * the same guard `fs_read`/`fs_write`/`shell_exec`/`ProcessManager` use).
 * `spawn()` is synchronous (it returns a live `PtySession` immediately, as
 * every caller — including the existing test suite — relies on), so the check
 * runs blocking, before the child is ever spawned; an escaping cwd throws
 * `NexusError("invalid_argument")` instead of launching. With no workspace
 * root configured, the default is `process.cwd()`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { scrubSecretEnv } from "../shell.js";
import { resolveInWorkspaceSync } from "../paths.js";

export interface PtySpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  /** Abort to kill the session. */
  signal?: AbortSignal;
}

/** Options shared by both Pty backend factories. */
export interface PtyBackendOptions {
  /** Workspace root a session's `cwd` is confined to (default: `process.cwd()`). */
  workspaceRoot?: string;
}

/** Terminal exit notification. */
export interface PtyExit {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** A live interactive session. Unsubscribe via the returned disposer. */
export interface PtySession {
  /** Underlying process id, if available. */
  readonly pid: number | undefined;
  /** Write raw input to the session. */
  write(data: string): void;
  /** Subscribe to raw output (ANSI preserved). Returns an unsubscribe fn. */
  onData(cb: (data: string) => void): () => void;
  /** Subscribe to the exit event. Returns an unsubscribe fn. */
  onExit(cb: (info: PtyExit) => void): () => void;
  /** Resize the terminal (no-op for the child_process seam). */
  resize(cols: number, rows: number): void;
  /** Terminate the session. */
  kill(signal?: NodeJS.Signals): void;
}

/** A Pty backend: a factory for interactive sessions. */
export interface Pty {
  readonly kind: "child_process" | "node-pty";
  spawn(command: string, args?: string[], opts?: PtySpawnOptions): PtySession;
}

/** Minimal callback fan-out. */
class Emitter<T> {
  private readonly cbs = new Set<(v: T) => void>();
  on(cb: (v: T) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  emit(v: T): void {
    for (const cb of [...this.cbs]) cb(v);
  }
}

/** Line-oriented child_process session — the always-available default. */
class ChildProcessSession implements PtySession {
  private readonly child: ChildProcess;
  private readonly data = new Emitter<string>();
  private readonly exit = new Emitter<PtyExit>();
  private exited = false;
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort: () => void;

  constructor(command: string, args: string[], opts: PtySpawnOptions) {
    const baseEnv = scrubSecretEnv(process.env);
    this.child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...baseEnv, ...opts.env } : baseEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.on("data", (d: Buffer) => this.data.emit(d.toString("utf8")));
    this.child.stderr?.on("data", (d: Buffer) => this.data.emit(d.toString("utf8")));
    this.child.on("close", (code: number | null, sig: NodeJS.Signals | null) => {
      if (this.exited) return;
      this.exited = true;
      if (this.signal) this.signal.removeEventListener("abort", this.onAbort);
      this.exit.emit({ exitCode: code, signal: sig });
    });
    this.child.on("error", () => {
      if (this.exited) return;
      this.exited = true;
      this.exit.emit({ exitCode: null, signal: null });
    });

    this.signal = opts.signal;
    this.onAbort = (): void => this.kill("SIGTERM");
    if (this.signal) {
      if (this.signal.aborted) this.onAbort();
      else this.signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  write(data: string): void {
    this.child.stdin?.write(data);
  }

  onData(cb: (data: string) => void): () => void {
    return this.data.on(cb);
  }

  onExit(cb: (info: PtyExit) => void): () => void {
    return this.exit.on(cb);
  }

  resize(_cols: number, _rows: number): void {
    /* line-oriented child_process has no window size; intentionally a no-op */
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    this.child.kill(signal);
  }
}

/** The always-available line-oriented Pty backed by `child_process`. */
export class ChildProcessPty implements Pty {
  readonly kind = "child_process" as const;
  private readonly workspaceRoot: string;

  constructor(opts: PtyBackendOptions = {}) {
    this.workspaceRoot = opts.workspaceRoot ?? process.cwd();
  }

  spawn(command: string, args: string[] = [], opts: PtySpawnOptions = {}): PtySession {
    const resolved =
      opts.cwd !== undefined
        ? { ...opts, cwd: resolveInWorkspaceSync(this.workspaceRoot, opts.cwd) }
        : opts;
    return new ChildProcessSession(command, args, resolved);
  }
}

/** Construct the default (always-available) Pty synchronously. */
export function createDefaultPty(opts: PtyBackendOptions = {}): Pty {
  return new ChildProcessPty(opts);
}

/**
 * Shape of the parts of `node-pty` we use, so the adapter is typed without a
 * compile-time dependency on the package.
 */
interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      cwd?: string | undefined;
      env?: Record<string, string | undefined> | undefined;
      cols?: number | undefined;
      rows?: number | undefined;
      name?: string | undefined;
    },
  ): NodePtyProcess;
}
interface NodePtyProcess {
  readonly pid: number;
  write(data: string): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

let nodePtyCache: NodePtyModule | null | undefined;

/**
 * Lazily attempt to load `node-pty`. Returns the module if installed, else
 * `null`. The specifier is held in a variable so the bundler/tsc treat it as a
 * runtime-only optional import and never fail when the package is absent.
 */
export async function loadNodePty(): Promise<NodePtyModule | null> {
  if (nodePtyCache !== undefined) return nodePtyCache;
  const specifier = "node-pty";
  try {
    const mod = (await import(specifier)) as { default?: NodePtyModule } & NodePtyModule;
    nodePtyCache = (mod.default ?? mod) as NodePtyModule;
  } catch {
    nodePtyCache = null;
  }
  return nodePtyCache;
}

/** True iff `node-pty` can be dynamically imported in this environment. */
export async function isNodePtyAvailable(): Promise<boolean> {
  return (await loadNodePty()) !== null;
}

class NodePtySession implements PtySession {
  private readonly proc: NodePtyProcess;
  private readonly disposers: Array<{ dispose(): void }> = [];
  private readonly signal: AbortSignal | undefined;
  private readonly onAbort: () => void;

  constructor(mod: NodePtyModule, command: string, args: string[], opts: PtySpawnOptions) {
    const baseEnv = scrubSecretEnv(process.env);
    this.proc = mod.spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...baseEnv, ...opts.env } : baseEnv,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      name: "xterm-color",
    });
    this.signal = opts.signal;
    this.onAbort = (): void => this.kill("SIGTERM");
    if (this.signal) {
      if (this.signal.aborted) this.onAbort();
      else this.signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }
  get pid(): number | undefined {
    return this.proc.pid;
  }
  write(data: string): void {
    this.proc.write(data);
  }
  onData(cb: (data: string) => void): () => void {
    const d = this.proc.onData(cb);
    this.disposers.push(d);
    return () => d.dispose();
  }
  onExit(cb: (info: PtyExit) => void): () => void {
    const d = this.proc.onExit((e) => cb({ exitCode: e.exitCode, signal: null }));
    this.disposers.push(d);
    return () => d.dispose();
  }
  resize(cols: number, rows: number): void {
    this.proc.resize(cols, rows);
  }
  kill(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.signal) this.signal.removeEventListener("abort", this.onAbort);
    for (const d of this.disposers.splice(0)) d.dispose();
    this.proc.kill(signal);
  }
}

class NodePtyBackend implements Pty {
  readonly kind = "node-pty" as const;
  private readonly workspaceRoot: string;

  constructor(
    private readonly mod: NodePtyModule,
    opts: PtyBackendOptions = {},
  ) {
    this.workspaceRoot = opts.workspaceRoot ?? process.cwd();
  }

  spawn(command: string, args: string[] = [], opts: PtySpawnOptions = {}): PtySession {
    const resolved =
      opts.cwd !== undefined
        ? { ...opts, cwd: resolveInWorkspaceSync(this.workspaceRoot, opts.cwd) }
        : opts;
    return new NodePtySession(this.mod, command, args, resolved);
  }
}

/**
 * Return the best available Pty backend: node-pty if installed, else the
 * always-available child_process default. NEVER throws for a missing node-pty.
 */
export async function createPty(opts: PtyBackendOptions = {}): Promise<Pty> {
  const mod = await loadNodePty();
  return mod ? new NodePtyBackend(mod, opts) : createDefaultPty(opts);
}
