/**
 * Instruction-file ingestion (system-spec §4). Walks from `cwd` up to the
 * filesystem root (plus the user's home dir as the outermost "global" scope)
 * collecting instruction files, and upserts them into the durable tiers:
 *
 *   CLAUDE.md, AGENTS.md      → `knowledge` (kind "instruction")
 *   .nexus/memory (file/dir)  → `long`      (kind "instruction")
 *
 * Hierarchical precedence: files nearer `cwd` are project scope and OVERRIDE
 * user/global ones. "Override" is realized two ways:
 *   1. a `precedence:<depth>` tag (0 = nearest) that boosts recall ranking, and
 *   2. deterministic ids keyed on the absolute path, so re-ingestion updates the
 *      same item (idempotent, auditable via `updatedAt`) instead of duplicating.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import type { MemoryStore } from "./store.js";
import type { MemoryItem, MemoryTier } from "./types.js";

/** Files that map to the `knowledge` tier. */
const KNOWLEDGE_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
/** Relative path that maps to the `long` tier (may be a file or a directory). */
const LONG_PATH = join(".nexus", "memory");

export interface IngestOptions {
  /** Starting directory (defaults to `process.cwd()`). */
  cwd?: string;
  /** Home directory used as the outermost global scope (defaults to `os.homedir()`). */
  home?: string;
  /** Stop after this many directory levels up from `cwd` (safety bound). */
  maxDepth?: number;
}

export interface IngestResult {
  /** Items created or updated, nearest-scope first. */
  items: MemoryItem[];
  /** Absolute paths that were read, nearest-scope first. */
  files: string[];
}

/** A discovered instruction file, tagged with its scope depth. */
interface Discovery {
  path: string;
  tier: MemoryTier;
  /** 0 = nearest to cwd (project); larger = farther/global. */
  depth: number;
  scope: "project" | "global";
}

/**
 * Discover, read, and upsert every instruction file reachable from `cwd`.
 * Nearer files are ingested with a smaller `precedence` depth so they outrank
 * farther/global ones during recall.
 */
export function ingestInstructionFiles(
  store: MemoryStore,
  opts: IngestOptions = {},
): IngestResult {
  const cwd = resolve(opts.cwd ?? process.cwd());
  const home = resolve(opts.home ?? homedir());
  const discoveries = discover(cwd, home, opts.maxDepth ?? 64);

  const items: MemoryItem[] = [];
  const files: string[] = [];
  for (const d of discoveries) {
    let text: string;
    try {
      text = readFileSync(d.path, "utf8");
    } catch {
      continue; // unreadable file: skip rather than fail the whole ingest
    }
    const item = store.put({
      tier: d.tier,
      kind: "instruction",
      text,
      source: d.path,
      id: instructionId(d.tier, d.path),
      tags: [`precedence:${d.depth}`, `scope:${d.scope}`, "instruction"],
    });
    items.push(item);
    files.push(d.path);
  }
  return { items, files };
}

/** Deterministic, path-keyed id so re-ingestion upserts the same record. */
export function instructionId(tier: MemoryTier, path: string): string {
  const h = createHash("sha256").update(`${tier}:${resolve(path)}`).digest("hex").slice(0, 16);
  return `instr_${h}`;
}

/** Walk cwd→root (project scope), then the home dir (global scope). */
function discover(cwd: string, home: string, maxDepth: number): Discovery[] {
  const out: Discovery[] = [];
  const seen = new Set<string>();
  let depth = 0;

  const collect = (dir: string, scope: "project" | "global"): void => {
    for (const rel of KNOWLEDGE_FILES) {
      const p = join(dir, rel);
      if (!seen.has(p) && isFile(p)) {
        seen.add(p);
        out.push({ path: p, tier: "knowledge", depth, scope });
      }
    }
    const longPath = join(dir, LONG_PATH);
    for (const p of expandLong(longPath)) {
      if (!seen.has(p)) {
        seen.add(p);
        out.push({ path: p, tier: "long", depth, scope });
      }
    }
  };

  // Project scope: cwd upward to filesystem root.
  const rootPath = parse(cwd).root;
  let dir = cwd;
  while (depth < maxDepth) {
    collect(dir, "project");
    if (dir === rootPath) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    depth++;
  }

  // Global scope: the home dir, unless it was already visited on the way up.
  depth++;
  if (!wasVisited(cwd, rootPath, home, maxDepth)) collect(home, "global");

  return out;
}

/** `.nexus/memory` may be a single file or a directory of files. */
function expandLong(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    const st = statSync(path);
    if (st.isFile()) return [path];
    if (st.isDirectory()) {
      return readdirSync(path)
        .map((name) => join(path, name))
        .filter((p) => isFile(p))
        .sort();
    }
  } catch {
    /* ignore */
  }
  return [];
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** True when `home` lies on the cwd→root chain already walked as project scope. */
function wasVisited(cwd: string, rootPath: string, home: string, maxDepth: number): boolean {
  let dir = cwd;
  let steps = 0;
  while (steps < maxDepth) {
    if (dir === home) return true;
    if (dir === rootPath) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    steps++;
  }
  return false;
}
