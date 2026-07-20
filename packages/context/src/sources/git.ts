/**
 * GitDiffSource — working-tree status + diff (volatile `git` lane) via
 * `child_process`. The runner is injectable (`run`) so it is testable without a
 * real repo; the default shells out to `git`. Not a repo / git missing ⇒ no chunks.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CollectContext, ContextChunk, ContextSource } from "../types.js";

const pexec = promisify(execFile);

/** Run a git subcommand in `cwd`, returning stdout (or "" on failure). */
export type GitRunner = (args: string[], cwd: string) => Promise<string>;

const defaultRunner: GitRunner = async (args, cwd) => {
  try {
    const { stdout } = await pexec("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch {
    return "";
  }
};

export interface GitDiffOptions {
  cwd?: string;
  /** Include staged changes (`git diff --staged`) as well. */
  staged?: boolean;
  /** Byte cap per section (status/diff). */
  maxBytes?: number;
  priority?: number;
  /** Injectable runner (defaults to shelling out to `git`). */
  run?: GitRunner;
}

function cap(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text;
  // Preserve the tail — the end of a diff carries the latest hunks.
  return "… (truncated)\n" + text.slice(text.length - maxBytes);
}

export class GitDiffSource implements ContextSource {
  readonly id = "git-diff";
  readonly kind = "volatile" as const;
  readonly priority: number;

  constructor(private readonly opts: GitDiffOptions = {}) {
    this.priority = opts.priority ?? 55;
  }

  async collect(ctx: CollectContext): Promise<ContextChunk[]> {
    const cwd = this.opts.cwd ?? ctx.cwd;
    const run = this.opts.run ?? defaultRunner;
    const maxBytes = this.opts.maxBytes ?? 8192;

    const status = (await run(["status", "--porcelain"], cwd)).trim();
    const diffArgs = this.opts.staged ? ["diff", "--staged"] : ["diff"];
    const diff = (await run(diffArgs, cwd)).trim();

    const chunks: ContextChunk[] = [];
    if (status.length > 0) {
      chunks.push({
        id: "git:status",
        sourceId: this.id,
        lane: "git",
        text: `git status --porcelain\n${cap(status, maxBytes)}`,
        priority: this.priority,
        relevance: 0.7,
        title: "Git Status",
      });
    }
    if (diff.length > 0) {
      chunks.push({
        id: "git:diff",
        sourceId: this.id,
        lane: "git",
        text: `${diffArgs.join(" ")}\n${cap(diff, maxBytes)}`,
        priority: this.priority,
        relevance: 0.65,
        title: "Git Diff",
      });
    }
    return chunks;
  }
}
