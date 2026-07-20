/**
 * CommandHistory — a persisted ring buffer of executed commands (system-spec §13,
 * "command history"). Entries are capped at a fixed capacity (oldest evicted),
 * persisted as JSON to a data-dir file with safe permissions (dir 0o700, file
 * 0o600, atomic tmp+rename write), and tolerant of a missing or corrupt file on
 * load. Persistence is synchronous, matching `@nexuscode/memory`'s store.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { REDACTED, redactSecrets } from "../redact.js";

/**
 * Flags whose *value* is a secret and must never be persisted: the value may be
 * glued (`-pS3cret`, `--password=…`, `--token:…`) or the next argv token
 * (`--password S3cret`). Kept in sync (in spirit) with redact.ts's key list.
 */
const SECRET_FLAG =
  /^--?(p|pw|pass|passwd|password|token|api[-_]?key|apikey|secret|client[-_]?secret|auth|authorization|bearer|access[-_]?key|session[-_]?token|credential)$/i;
/** `--flag=value` / `--flag:value` glued form for a secret-bearing flag. */
const SECRET_FLAG_INLINE =
  /^(--?(?:p|pw|pass|passwd|password|token|api[-_]?key|apikey|secret|client[-_]?secret|auth|authorization|bearer|access[-_]?key|session[-_]?token|credential))([=:])(.+)$/i;
/** mysql-style glued short password flag: `-pS3cret` (but not a bare `-p`). */
const SHORT_GLUED_PASSWORD = /^(-p)(.+)$/;

/**
 * Scrub secrets out of an argv before it is persisted. Three passes per token:
 * a glued secret flag (`--password=…`, `-pS3cret`) keeps the flag and masks the
 * value; a standalone secret flag (`--password`) masks the following value
 * token; anything else is run through {@link redactSecrets} so bearer tokens,
 * provider-key shapes, and URL-embedded credentials are masked wherever they
 * appear. This mirrors the gate's audit redaction so history never stores a
 * live credential (system-spec §13 "command-history not storing secrets").
 */
export function scrubHistoryArgs(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const inline = SECRET_FLAG_INLINE.exec(a);
    if (inline) {
      out.push(`${inline[1]}${inline[2]}${REDACTED}`);
      continue;
    }
    const glued = SHORT_GLUED_PASSWORD.exec(a);
    if (glued) {
      out.push(`${glued[1]}${REDACTED}`);
      continue;
    }
    if (SECRET_FLAG.test(a)) {
      out.push(a);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out.push(REDACTED);
        i++;
      }
      continue;
    }
    out.push(redactSecrets(a));
  }
  return out;
}

/** One recorded command invocation. */
export interface HistoryEntry {
  /** Executable that was run. */
  command: string;
  /** Argument vector. */
  args: string[];
  /** Working directory it ran in, if known. */
  cwd?: string;
  /** Exit code, if the command completed. */
  exitCode?: number | null;
  /** Epoch-ms timestamp the entry was recorded. */
  ts: number;
}

export interface CommandHistoryOptions {
  /** File to persist to (default: `<data-dir>/command-history.json`). */
  filePath?: string;
  /** Max entries retained; older ones are evicted (default 1000). */
  capacity?: number;
}

/** Default persisted-history path, honoring `NEXUSCODE_DATA_DIR` and platform. */
export function defaultHistoryPath(): string {
  const base =
    process.env.NEXUSCODE_DATA_DIR ??
    (process.platform === "win32"
      ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "nexuscode")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", "nexuscode")
        : process.env.XDG_DATA_HOME
          ? join(process.env.XDG_DATA_HOME, "nexuscode")
          : join(homedir(), ".local", "share", "nexuscode"));
  return join(base, "command-history.json");
}

interface PersistShape {
  version: 1;
  entries: HistoryEntry[];
}

function isEntry(v: unknown): v is HistoryEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.command === "string" &&
    Array.isArray(o.args) &&
    o.args.every((a) => typeof a === "string") &&
    typeof o.ts === "number"
  );
}

export class CommandHistory {
  readonly filePath: string;
  readonly capacity: number;
  private entries: HistoryEntry[] = [];

  constructor(opts: CommandHistoryOptions = {}) {
    this.filePath = opts.filePath ?? defaultHistoryPath();
    this.capacity = Math.max(1, opts.capacity ?? 1000);
    this.load();
  }

  /** (Re)load from disk. Missing or corrupt files yield an empty history. */
  load(): void {
    try {
      const raw = readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const arr = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as PersistShape).entries)
          ? (parsed as PersistShape).entries
          : [];
      this.entries = arr.filter(isEntry).slice(-this.capacity);
    } catch {
      this.entries = [];
    }
  }

  /** Append a command, evicting the oldest if over capacity, then persist. */
  append(entry: Omit<HistoryEntry, "ts"> & { ts?: number }): HistoryEntry {
    const full: HistoryEntry = {
      command: redactSecrets(entry.command),
      args: scrubHistoryArgs(entry.args),
      ...(entry.cwd !== undefined ? { cwd: redactSecrets(entry.cwd) } : {}),
      ...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
      ts: entry.ts ?? Date.now(),
    };
    this.entries.push(full);
    if (this.entries.length > this.capacity) {
      this.entries = this.entries.slice(-this.capacity);
    }
    this.persist();
    return full;
  }

  /** All entries, oldest→newest (a copy). */
  list(): HistoryEntry[] {
    return this.entries.map((e) => ({ ...e, args: [...e.args] }));
  }

  /** The `n` most-recent entries, newest→oldest. */
  recent(n: number): HistoryEntry[] {
    return this.entries
      .slice(-Math.max(0, n))
      .reverse()
      .map((e) => ({ ...e, args: [...e.args] }));
  }

  /** Number of retained entries. */
  get size(): number {
    return this.entries.length;
  }

  /** Clear all entries and persist the empty history. */
  clear(): void {
    this.entries = [];
    this.persist();
  }

  private persist(): void {
    const dir = dirname(this.filePath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const data: PersistShape = { version: 1, entries: this.entries };
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.filePath);
    try {
      chmodSync(this.filePath, 0o600);
    } catch {
      /* best-effort on platforms without POSIX perms */
    }
  }
}
