/**
 * Git-context helpers (system-spec §14) — status, diff, log, blame, branch.
 *
 * Every helper shells out through {@link runGit} (execFile, no shell) and parses
 * git's machine-readable output into typed structures. These are the read-only
 * "context gathering" primitives the LLM-driven flows in `flows.ts` build on.
 */

import { NexusError } from "@nexuscode/shared";
import { runGit, runGitOrThrow, type GitExecOptions } from "./exec.js";

/**
 * Reject a caller-supplied ref/rev that could be mistaken for a git CLI
 * option. `diff()`/`log()` interpolate `opts.ref` directly into the argument
 * vector, so a ref like `--output=/tmp/pwned` would smuggle an option
 * (`git diff --output=...` writes an arbitrary file) into the invocation.
 * Legitimate refs (`HEAD~1`, `main...feature`, a commit hash) never start
 * with `-`, so rejecting that prefix is safe and non-breaking.
 */
function assertSafeRef(ref: string): void {
  if (ref.startsWith("-")) {
    throw new NexusError("invalid_argument", `invalid git ref: ${ref}`);
  }
}

/** Base options accepted by every context helper. */
export type GitContextOptions = Omit<GitExecOptions, "cwd"> & { cwd: string };

function base(opts: GitContextOptions): GitExecOptions {
  const b: GitExecOptions = { cwd: opts.cwd };
  if (opts.signal) b.signal = opts.signal;
  if (opts.timeoutMs !== undefined) b.timeoutMs = opts.timeoutMs;
  if (opts.maxBuffer !== undefined) b.maxBuffer = opts.maxBuffer;
  if (opts.env !== undefined) b.env = opts.env;
  return b;
}

/** True iff `cwd` is inside a git work tree. */
export async function isGitRepo(opts: GitContextOptions): Promise<boolean> {
  const r = await runGit(["rev-parse", "--is-inside-work-tree"], base(opts));
  return r.ok && r.stdout.trim() === "true";
}

/** The absolute path to the repository's top-level working directory. */
export async function repoRoot(opts: GitContextOptions): Promise<string> {
  return (await runGitOrThrow(["rev-parse", "--show-toplevel"], base(opts))).trim();
}

// ── status ────────────────────────────────────────────────────────────────

export interface FileStatus {
  /** Path relative to the repo root (the destination path for renames). */
  path: string;
  /** Original path for a rename/copy, if any. */
  origPath?: string;
  /** Single-letter index (staged) status: `M`, `A`, `D`, `R`, `C`, `?`, ` `. */
  index: string;
  /** Single-letter worktree (unstaged) status. */
  worktree: string;
  /** True if the change is staged in the index. */
  staged: boolean;
  /** True for an untracked file (`??`). */
  untracked: boolean;
}

export interface StatusResult {
  branch?: string;
  files: FileStatus[];
  /** True when the working tree and index are both clean. */
  clean: boolean;
  /** The raw `git status --porcelain` output, for prompts/debugging. */
  raw: string;
}

/** Parse `git status --porcelain=v1 --branch` into a typed summary. */
export async function status(opts: GitContextOptions): Promise<StatusResult> {
  const raw = await runGitOrThrow(
    ["status", "--porcelain=v1", "--branch", "-z"],
    base(opts),
  );
  // With `-z`, records are NUL-separated. A rename record is followed by an
  // extra NUL-terminated field carrying the original path.
  const parts = raw.split("\0");
  const files: FileStatus[] = [];
  let branch: string | undefined;

  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith("##")) {
      // "## main...origin/main [ahead 1]" → take the local branch name.
      const rest = line.slice(2).trim();
      branch = rest.split(/\.{3}| /)[0]?.trim();
      continue;
    }
    const index = line[0] ?? " ";
    const worktree = line[1] ?? " ";
    let path = line.slice(3);
    const entry: FileStatus = {
      path,
      index,
      worktree,
      staged: index !== " " && index !== "?",
      untracked: index === "?" && worktree === "?",
    };
    if (index === "R" || index === "C") {
      // The very next NUL-separated field is the original path.
      const orig = parts[i + 1];
      if (orig) {
        entry.origPath = orig;
        i += 1;
      }
    }
    path = entry.path;
    files.push(entry);
  }

  return { ...(branch ? { branch } : {}), files, clean: files.length === 0, raw };
}

// ── diff ──────────────────────────────────────────────────────────────────

export interface DiffOptions extends GitContextOptions {
  /** Diff the staged index against HEAD instead of the working tree. */
  staged?: boolean;
  /** A ref or ref range (e.g. `HEAD~1`, `main...feature`) to diff against. */
  ref?: string;
  /** Restrict the diff to these pathspecs. */
  paths?: string[];
  /** Produce `--stat` summary output instead of a full patch. */
  stat?: boolean;
}

/** Run `git diff` with the requested scope and return the unified patch text. */
export async function diff(opts: DiffOptions): Promise<string> {
  const args = ["diff", "--no-color"];
  if (opts.staged) args.push("--cached");
  if (opts.stat) args.push("--stat");
  if (opts.ref) {
    assertSafeRef(opts.ref);
    args.push(opts.ref);
  }
  if (opts.paths && opts.paths.length > 0) args.push("--", ...opts.paths);
  return runGitOrThrow(args, base(opts));
}

// ── log ───────────────────────────────────────────────────────────────────

export interface LogEntry {
  hash: string;
  author: string;
  email: string;
  date: string;
  subject: string;
  body: string;
}

export interface LogOptions extends GitContextOptions {
  /** Max number of commits. Default 20. */
  maxCount?: number;
  /** A ref or range to log (e.g. `main..feature`). */
  ref?: string;
  /** Restrict to these pathspecs. */
  paths?: string[];
}

const FIELD = "\x1f"; // between fields within a record
const RECORD = "\x1e"; // between records

/** Parse `git log` into structured entries using unambiguous delimiters. */
export async function log(opts: LogOptions): Promise<LogEntry[]> {
  const format = ["%H", "%an", "%ae", "%aI", "%s", "%b"].join(FIELD) + RECORD;
  const args = ["log", `--max-count=${opts.maxCount ?? 20}`, `--pretty=format:${format}`];
  if (opts.ref) {
    assertSafeRef(opts.ref);
    args.push(opts.ref);
  }
  if (opts.paths && opts.paths.length > 0) args.push("--", ...opts.paths);
  const raw = await runGitOrThrow(args, base(opts));

  const entries: LogEntry[] = [];
  for (const record of raw.split(RECORD)) {
    const trimmed = record.replace(/^\n+/, "");
    if (trimmed.trim().length === 0) continue;
    const [hash = "", author = "", email = "", date = "", subject = "", body = ""] =
      trimmed.split(FIELD);
    entries.push({ hash, author, email, date, subject, body: body.trimEnd() });
  }
  return entries;
}

// ── branch ────────────────────────────────────────────────────────────────

export interface BranchInfo {
  /** The checked-out branch, or `undefined` in a detached HEAD. */
  current?: string;
  /** All local branch names. */
  all: string[];
}

/** The currently checked-out branch (undefined when HEAD is detached). */
export async function currentBranch(opts: GitContextOptions): Promise<string | undefined> {
  const r = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], base(opts));
  const name = r.stdout.trim();
  if (!r.ok || name === "" || name === "HEAD") return undefined;
  return name;
}

/** List local branches and identify the current one. */
export async function branch(opts: GitContextOptions): Promise<BranchInfo> {
  const raw = await runGitOrThrow(
    ["branch", "--format=%(refname:short)"],
    base(opts),
  );
  const all = raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const current = await currentBranch(opts);
  return { ...(current ? { current } : {}), all };
}

// ── blame ─────────────────────────────────────────────────────────────────

export interface BlameLine {
  /** 1-based final line number in the file. */
  line: number;
  /** The commit hash that last touched this line. */
  hash: string;
  author: string;
  /** The line's content. */
  content: string;
}

export interface BlameOptions extends GitContextOptions {
  /** File to blame, relative to the repo root. */
  file: string;
  /** Optional 1-based inclusive line range `[start, end]`. */
  range?: [number, number];
}

/** Parse `git blame --line-porcelain` for a file into per-line attribution. */
export async function blame(opts: BlameOptions): Promise<BlameLine[]> {
  const args = ["blame", "--line-porcelain"];
  if (opts.range) args.push("-L", `${opts.range[0]},${opts.range[1]}`);
  args.push("--", opts.file);
  const raw = await runGitOrThrow(args, base(opts));

  const lines: BlameLine[] = [];
  let hash = "";
  let author = "";
  let finalLine = 0;
  for (const l of raw.split("\n")) {
    // A header line: "<40-hex> <orig> <final> [<count>]".
    const header = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/.exec(l);
    if (header) {
      hash = header[1] ?? "";
      finalLine = Number(header[2] ?? "0");
      continue;
    }
    if (l.startsWith("author ")) {
      author = l.slice("author ".length);
      continue;
    }
    if (l.startsWith("\t")) {
      lines.push({ line: finalLine, hash, author, content: l.slice(1) });
    }
  }
  return lines;
}
