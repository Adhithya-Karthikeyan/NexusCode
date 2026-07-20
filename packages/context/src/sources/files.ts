/**
 * ProjectFilesSource — a deterministic repo map (and optional file contents)
 * for the static `repo-map` lane. Respects ignore rules: the built-in walker's
 * default ignore dirs plus patterns read from `.gitignore` / `.nexusignore`
 * (and any extra `ignore` globs).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_IGNORE, globToRegExp, walkFiles } from "@nexuscode/tools";
import type { CollectContext, ContextChunk, ContextSource } from "../types.js";

export interface ProjectFilesOptions {
  /** Root to scan (default: `ctx.cwd`). */
  root?: string;
  /** Only include files matching these globs (relative, posix). */
  include?: string[];
  /** Extra ignore globs on top of the ignore files. */
  ignore?: string[];
  /** Ignore files to read for patterns (default `.gitignore`, `.nexusignore`). */
  ignoreFiles?: string[];
  /** Cap on files listed/read. */
  maxFiles?: number;
  /** Include file contents as chunks (default: tree only). */
  contents?: boolean;
  /** Per-file byte cap when reading contents. */
  maxBytesPerFile?: number;
  priority?: number;
}

function matchesAny(rel: string, regexes: RegExp[]): boolean {
  const base = rel.split("/").pop() ?? rel;
  for (const re of regexes) {
    if (re.test(rel) || re.test(base)) return true;
  }
  return false;
}

/** Compile gitignore-style patterns into anchored regexes (no negation). */
function compileIgnore(patterns: string[]): RegExp[] {
  const out: RegExp[] = [];
  for (const raw of patterns) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith("!")) continue;
    let pat = line.replace(/^\/+/, "").replace(/\/+$/, "");
    if (pat.length === 0) continue;
    out.push(globToRegExp(pat));
    // A directory pattern also excludes everything under it.
    out.push(globToRegExp(`${pat}/**`));
    if (!pat.includes("/")) out.push(globToRegExp(`**/${pat}`));
  }
  return out;
}

async function readIgnoreFiles(root: string, names: string[]): Promise<string[]> {
  const patterns: string[] = [];
  for (const name of names) {
    try {
      const text = await fs.readFile(path.join(root, name), "utf8");
      patterns.push(...text.split(/\r?\n/));
    } catch {
      // Missing ignore file is fine.
    }
  }
  return patterns;
}

export class ProjectFilesSource implements ContextSource {
  readonly id = "project-files";
  readonly kind = "static" as const;
  readonly priority: number;

  constructor(private readonly opts: ProjectFilesOptions = {}) {
    this.priority = opts.priority ?? 70;
  }

  async collect(ctx: CollectContext): Promise<ContextChunk[]> {
    const root = this.opts.root ?? ctx.cwd;
    const maxFiles = this.opts.maxFiles ?? 200;
    const ignoreFiles = this.opts.ignoreFiles ?? [".gitignore", ".nexusignore"];

    const ignorePatterns = [
      ...(await readIgnoreFiles(root, ignoreFiles)),
      ...(this.opts.ignore ?? []),
    ];
    const ignoreRegexes = compileIgnore(ignorePatterns);
    const includeRegexes = (this.opts.include ?? []).map(globToRegExp);

    let files: string[];
    try {
      files = await walkFiles(root, { ignore: DEFAULT_IGNORE, limit: 50_000 });
    } catch {
      return [];
    }

    files = files
      .filter((f) => (includeRegexes.length === 0 ? true : matchesAny(f, includeRegexes)))
      .filter((f) => !matchesAny(f, ignoreRegexes))
      .sort();

    const truncated = files.length > maxFiles;
    const listed = files.slice(0, maxFiles);

    const chunks: ContextChunk[] = [];
    const treeBody = listed.join("\n") + (truncated ? `\n… (${files.length - maxFiles} more)` : "");
    chunks.push({
      id: "repo-map:tree",
      sourceId: this.id,
      lane: "repo-map",
      text: treeBody,
      priority: this.priority,
      relevance: 0.6,
      title: "Repo Map",
    });

    if (this.opts.contents) {
      const cap = this.opts.maxBytesPerFile ?? 4096;
      for (const rel of listed) {
        try {
          const full = path.join(root, rel);
          const buf = await fs.readFile(full, "utf8");
          const body = buf.length > cap ? buf.slice(0, cap) + "\n… (truncated)" : buf;
          chunks.push({
            id: `repo-file:${rel}`,
            sourceId: this.id,
            lane: "repo-map",
            text: `--- ${rel} ---\n${body}`,
            priority: this.priority,
            relevance: 0.4,
            title: rel,
          });
        } catch {
          // Unreadable file — skip.
        }
      }
    }

    return chunks;
  }
}
