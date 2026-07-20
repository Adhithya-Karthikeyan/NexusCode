/**
 * ProjectConventionsSource — the project's instruction files (CLAUDE.md /
 * AGENTS.md) on the static `conventions` lane. These are the conventional
 * "how to work in this repo" files every coding harness is expected to honour;
 * without them the model answers from generic priors instead of the project's
 * rules.
 *
 * Discovery walks from `cwd` up to the filesystem root (project scope), then the
 * user's home directory (global scope), mirroring `@nexuscode/memory`'s
 * hierarchical precedence — but as a PURE READ: unlike `ingestInstructionFiles`
 * it never writes to a durable store, so it is safe on the per-request context
 * path.
 *
 * Nearer files outrank farther ones (higher `relevance`), and emission order is
 * deterministic (nearest first) so the chunk text stays byte-stable turn-to-turn
 * and the cacheable static prefix keeps hitting the provider prompt-cache.
 *
 * Bounded by construction: per-file byte cap, a cap on how many files are
 * emitted, and a depth bound on the upward walk. Chunks are NOT pinned — a
 * pathological CLAUDE.md must be compressible/trimmable by the engine rather
 * than able to crowd out the rest of the window.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { CollectContext, ContextChunk, ContextSource } from "../types.js";

/** Conventional instruction filenames, in emission order within a directory. */
const CONVENTION_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

export interface ProjectConventionsOptions {
  /** Directory to start the upward walk from (default: `ctx.cwd`). */
  cwd?: string;
  /** Home directory used as the outermost global scope (default `os.homedir()`). */
  home?: string;
  /** Extra filenames to treat as instruction files (default CLAUDE.md/AGENTS.md). */
  files?: string[];
  /** Stop after this many directory levels above `cwd` (default 32). */
  maxDepth?: number;
  /** Cap on how many instruction files are emitted, nearest first (default 4). */
  maxFiles?: number;
  /** Per-file byte cap; longer files are truncated with a marker (default 8192). */
  maxBytesPerFile?: number;
  /** Include the home-directory (global scope) files as well (default true). */
  includeGlobal?: boolean;
  priority?: number;
}

/** One discovered instruction file. `depth` 0 = nearest to cwd. */
interface Discovery {
  file: string;
  depth: number;
  scope: "project" | "global";
}

export class ProjectConventionsSource implements ContextSource {
  readonly id = "project-conventions";
  readonly kind = "static" as const;
  readonly priority: number;

  constructor(private readonly opts: ProjectConventionsOptions = {}) {
    this.priority = opts.priority ?? 85;
  }

  async collect(ctx: CollectContext): Promise<ContextChunk[]> {
    const cwd = path.resolve(this.opts.cwd ?? ctx.cwd);
    const names = this.opts.files ?? [...CONVENTION_FILES];
    const maxFiles = this.opts.maxFiles ?? 4;
    const maxBytes = this.opts.maxBytesPerFile ?? 8192;

    const found = this.discover(cwd, names);

    const chunks: ContextChunk[] = [];
    for (const d of found) {
      if (chunks.length >= maxFiles) break;
      let text: string;
      try {
        text = await fs.readFile(d.file, "utf8");
      } catch {
        continue; // Unreadable file: skip rather than fail the whole source.
      }
      const trimmed = text.trim();
      if (trimmed.length === 0) continue;
      const body =
        trimmed.length > maxBytes ? `${trimmed.slice(0, maxBytes)}\n… (truncated)` : trimmed;
      // Relevance decays with distance so nearer (project) rules outrank global
      // ones when the engine has to choose what survives.
      const relevance = Math.max(0.5, 1 - d.depth * 0.1);
      chunks.push({
        id: `conventions:${d.file}`,
        sourceId: this.id,
        lane: "conventions",
        text: `--- ${d.file} ---\n${body}`,
        priority: this.priority,
        relevance,
        title: path.basename(d.file),
        meta: { path: d.file, scope: d.scope, depth: d.depth },
      });
    }
    return chunks;
  }

  /** Walk cwd→root (project scope), then the home dir (global scope). */
  private discover(cwd: string, names: string[]): Discovery[] {
    const maxDepth = this.opts.maxDepth ?? 32;
    const home = path.resolve(this.opts.home ?? homedir());
    const out: Discovery[] = [];
    const seen = new Set<string>();

    const collect = (dir: string, depth: number, scope: "project" | "global"): void => {
      for (const name of names) {
        const p = path.join(dir, name);
        if (seen.has(p)) continue;
        seen.add(p);
        out.push({ file: p, depth, scope });
      }
    };

    const root = path.parse(cwd).root;
    let dir = cwd;
    let depth = 0;
    let reachedHome = dir === home;
    while (depth < maxDepth) {
      collect(dir, depth, "project");
      if (dir === root) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
      depth++;
      if (dir === home) reachedHome = true;
    }

    // Global scope: the home dir, unless the upward walk already covered it.
    if ((this.opts.includeGlobal ?? true) && !reachedHome) {
      collect(home, depth + 1, "global");
    }
    return out;
  }
}
