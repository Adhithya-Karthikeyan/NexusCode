/**
 * A dependency-free glob matcher and directory walker for `fs_search`. Supports
 * `**` (any number of path segments), `*` (any run within a segment), and `?`
 * (a single non-separator char). Paths are compared in posix form so patterns
 * are portable across platforms.
 */

import { promises as fs } from "node:fs";
import path from "node:path";

/** Directory names never descended into during a walk. */
export const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "coverage",
]);

/** Compile a glob into an anchored RegExp against posix-style relative paths. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` — any number of segments (including zero). Swallow a trailing `/`.
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

/**
 * Recursively collect files under `root`, returning posix-relative paths.
 * Skips `ignore` directory names. Bounded by `limit` to avoid unbounded walks.
 */
export async function walkFiles(
  root: string,
  opts: { ignore?: Set<string>; limit?: number } = {},
): Promise<string[]> {
  const ignore = opts.ignore ?? DEFAULT_IGNORE;
  const limit = opts.limit ?? 50_000;
  const out: string[] = [];

  async function recurse(dir: string): Promise<void> {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) return;
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        await recurse(path.join(dir, entry.name));
      } else if (entry.isFile()) {
        out.push(toPosix(path.relative(root, path.join(dir, entry.name))));
      }
    }
  }

  await recurse(root);
  return out;
}
