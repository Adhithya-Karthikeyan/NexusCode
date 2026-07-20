/**
 * Ignore-aware project tree walker (system-spec §11). Descends from a root,
 * honouring ignore rules read from `.gitignore` / `.nexusignore` / `.aiignore`
 * (plus the built-in ignored directory names and any caller-supplied globs), and
 * guarding against oversized files. Paths are returned posix-relative and sorted
 * for deterministic output. Reuses `@nexuscode/tools`' `globToRegExp` so ignore
 * semantics match the rest of NexusCode.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_IGNORE, globToRegExp } from "@nexuscode/tools";
import { detectLanguage, type Lang } from "./language.js";

/** Default ignore files, most-general first. */
export const DEFAULT_IGNORE_FILES: readonly string[] = [".gitignore", ".nexusignore", ".aiignore"];

/**
 * Built-in secret-file denylist (gitignore-style globs) applied on EVERY walk,
 * regardless of the project's `.gitignore`/`.nexusignore`/`.aiignore`. This keeps
 * credential files out of the indexer/repo-map so their contents can never be
 * chunked, embedded (locally or over the network), or persisted into
 * `rag-index.json`. It is the file-level half of the "no secret persisted"
 * defense; content-level redaction (`@nexuscode/rag` `redactSecrets`) covers
 * secrets that live inside otherwise-indexable files.
 */
export const DEFAULT_SECRET_IGNORE: readonly string[] = [
  ".env",
  ".env.*",
  "*.env",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "*.pkcs12",
  "*.keystore",
  "*.jks",
  "id_rsa*",
  "id_dsa*",
  "id_ecdsa*",
  "id_ed25519*",
  "*.ppk",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".htpasswd",
  "credentials",
  "credentials.*",
  "*credentials*",
  "*secret*",
  "*secrets*",
  "service-account*.json",
  "gcp-*.json",
  // Whole credential directories — bare names so the walker prunes the entire
  // subtree (compileIgnore anchors `<name>` and `**/<name>`).
  ".aws",
  ".ssh",
  ".gnupg",
];

/** Default per-file byte guard: files larger than this are skipped. */
export const DEFAULT_MAX_FILE_BYTES = 1_000_000;

/**
 * Default aggregate byte budget across every file a walk returns (distinct
 * from the per-file {@link DEFAULT_MAX_FILE_BYTES} guard). Bounds how much
 * content a downstream caller (e.g. `buildIndex`, `collectIndexableDocs`) can
 * ever be asked to hold in memory at once for a single walk — the per-file
 * guard alone doesn't stop a repo with many small/medium files from summing
 * to an unbounded total (system-spec §11 aggregate-memory guard).
 */
export const DEFAULT_MAX_TOTAL_BYTES = 128 * 1024 * 1024; // 128 MiB

export interface WalkOptions {
  /** Root directory to scan (default: the `root` argument). */
  root?: string;
  /** Ignore files to read patterns from (default {@link DEFAULT_IGNORE_FILES}). */
  ignoreFiles?: readonly string[];
  /** Extra gitignore-style patterns applied on top of the ignore files. */
  extraIgnore?: readonly string[];
  /** Directory names never descended into (default {@link DEFAULT_IGNORE}). */
  ignoreDirs?: ReadonlySet<string>;
  /** Skip files larger than this many bytes (default {@link DEFAULT_MAX_FILE_BYTES}). 0 disables. */
  maxFileBytes?: number;
  /** Hard cap on the number of files returned. */
  maxFiles?: number;
  /**
   * Aggregate byte budget summed across every returned file's size (default
   * {@link DEFAULT_MAX_TOTAL_BYTES}). `0` disables the budget. Once reached the
   * walk stops early and a truncation notice is written to stderr — truncation
   * is never silent (system-spec §11).
   */
  maxTotalBytes?: number;
  /** Only return files whose detected language is in this set. */
  langs?: ReadonlySet<Lang>;
  /**
   * Include known secret files ({@link DEFAULT_SECRET_IGNORE}) in the walk. Off by
   * default — the denylist is applied on every walk regardless of the project's
   * ignore files. Set true only for trusted tooling that must see these paths.
   */
  includeSecretFiles?: boolean;
}

/** One walked file. */
export interface WalkEntry {
  /** Posix path relative to the walk root. */
  path: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Size in bytes. */
  bytes: number;
  /**
   * Last-modification time in epoch millis (from the same `stat` that read
   * `bytes`). Used by the incremental indexer to detect changed files without
   * reading their content (system-spec §23).
   */
  mtimeMs: number;
  /** Language detected from the path (content is not read during the walk). */
  lang: Lang;
}

/** Compile gitignore-style patterns into anchored regexes (negation ignored). */
export function compileIgnore(patterns: readonly string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const raw of patterns) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
    const pat = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (pat.length === 0) continue;
    out.push(globToRegExp(pat));
    out.push(globToRegExp(`${pat}/**`));
    if (!pat.includes("/")) out.push(globToRegExp(`**/${pat}`));
  }
  return out;
}

/** True when `rel` (or its basename) matches any compiled pattern. */
export function matchesAny(rel: string, regexes: readonly RegExp[]): boolean {
  const base = rel.split("/").pop() ?? rel;
  for (const re of regexes) {
    if (re.test(rel) || re.test(base)) return true;
  }
  return false;
}

async function readIgnoreFiles(root: string, names: readonly string[]): Promise<string[]> {
  const patterns: string[] = [];
  for (const name of names) {
    try {
      const text = await fs.readFile(path.join(root, name), "utf8");
      patterns.push(...text.split(/\r?\n/));
    } catch {
      // Missing ignore file is expected.
    }
  }
  return patterns;
}

/** `bytes` formatted as MiB with one decimal place, for human-readable log messages. */
function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}

/**
 * Walk `root`, returning ignore-filtered, size-guarded {@link WalkEntry}s sorted
 * by path. Directory recursion is pruned both by the ignored-dir set and by
 * ignore-file patterns, so ignored trees are never descended into.
 *
 * Two aggregate budgets guard against an unbounded-memory DoS from a large or
 * maliciously-crafted tree: {@link WalkOptions.maxFiles} (file count) and
 * {@link WalkOptions.maxTotalBytes} (summed file size). Either cap stops the
 * walk early — but never silently: a truncation notice is written to stderr so
 * a partial index is never mistaken for a complete one.
 */
export async function walkProject(root: string, opts: WalkOptions = {}): Promise<WalkEntry[]> {
  const base = opts.root ?? root;
  const ignoreDirs = opts.ignoreDirs ?? DEFAULT_IGNORE;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxFiles = opts.maxFiles ?? 50_000;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;

  const patterns = [
    // The secret denylist is applied FIRST and unconditionally (a project's
    // ignore files cannot re-include a credential file), unless explicitly
    // opted out.
    ...(opts.includeSecretFiles ? [] : DEFAULT_SECRET_IGNORE),
    ...(await readIgnoreFiles(base, opts.ignoreFiles ?? DEFAULT_IGNORE_FILES)),
    ...(opts.extraIgnore ?? []),
  ];
  const ignoreRegexes = compileIgnore(patterns);

  const entries: WalkEntry[] = [];
  let totalBytes = 0;
  let truncated = false;

  const budgetReached = (): boolean =>
    entries.length >= maxFiles || (maxTotalBytes > 0 && totalBytes >= maxTotalBytes);

  async function recurse(dir: string): Promise<void> {
    if (budgetReached()) {
      truncated = true;
      return;
    }
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (budgetReached()) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, dirent.name);
      const rel = path.relative(base, abs).split(path.sep).join("/");

      if (dirent.isDirectory()) {
        if (ignoreDirs.has(dirent.name)) continue;
        if (matchesAny(rel, ignoreRegexes)) continue;
        await recurse(abs);
        continue;
      }
      if (!dirent.isFile()) continue;
      if (matchesAny(rel, ignoreRegexes)) continue;

      let bytes: number;
      let mtimeMs: number;
      try {
        const st = await fs.stat(abs);
        bytes = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        continue;
      }
      if (maxFileBytes > 0 && bytes > maxFileBytes) continue;

      if (maxTotalBytes > 0 && totalBytes + bytes > maxTotalBytes) {
        truncated = true;
        return;
      }

      const lang = detectLanguage(rel);
      if (opts.langs && !opts.langs.has(lang)) continue;

      totalBytes += bytes;
      entries.push({ path: rel, absPath: abs, bytes, mtimeMs, lang });
    }
  }

  await recurse(base);
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  if (truncated) {
    process.stderr.write(
      `index: reached limit (${entries.length} of ${maxFiles} files / ${mib(totalBytes)} MiB) — ` +
        `indexed a subset; raise fileintel.maxTotalFiles / fileintel.maxTotalBytes to include more.\n`,
    );
  }

  return entries;
}
