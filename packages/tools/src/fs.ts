/**
 * Filesystem built-ins: `fs_read`, `fs_write`, `fs_search`. Each is confined to
 * the workspace root via `resolveInWorkspace`, validates its own arguments, and
 * returns a normalized `ToolResult`. `fs_patch` lives in `./patch.ts`.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { DEFAULT_IGNORE, globToRegExp, walkFiles } from "./glob.js";
import { resolveInWorkspace } from "./paths.js";
import { errText, okText, textBlock, type Tool, type ToolContext, type ToolResult } from "./types.js";
import { asObject, optNumber, optStringArray, reqString } from "./validate.js";

const DEFAULT_MAX_BYTES = 256 * 1024;

/** Wall-clock budget for `fs_search`'s grep pass, guarding against ReDoS patterns. */
const DEFAULT_SEARCH_DEADLINE_MS = 2000;
/** A pattern longer than this is refused outright (cheap defense-in-depth). */
const MAX_PATTERN_LENGTH = 500;

function errnoCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const c = (err as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// fs_read
// ---------------------------------------------------------------------------

export const fsReadTool: Tool = {
  name: "fs_read",
  description: "Read a UTF-8 text file within the workspace. Truncates at maxBytes.",
  permission: "read",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      maxBytes: { type: "number", description: "Max bytes to return (default 262144)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const o = asObject(input);
    const rel = reqString(o, "path");
    const maxBytes = optNumber(o, "maxBytes") ?? DEFAULT_MAX_BYTES;
    const abs = await resolveInWorkspace(ctx.cwd, rel);
    try {
      const buf = await fs.readFile(abs);
      const truncated = buf.length > maxBytes;
      const text = buf.subarray(0, maxBytes).toString("utf8");
      if (!truncated) return okText(text);
      return {
        ok: true,
        content: [textBlock(text), textBlock(`\n[truncated: ${buf.length} bytes total, showed ${maxBytes}]`)],
      };
    } catch (err) {
      const code = errnoCode(err);
      if (code === "ENOENT") return errText(`file not found: ${rel}`);
      if (code === "EISDIR") return errText(`path is a directory: ${rel}`);
      return errText(`read failed: ${rel} (${code ?? "error"})`);
    }
  },
};

// ---------------------------------------------------------------------------
// fs_write
// ---------------------------------------------------------------------------

export const fsWriteTool: Tool = {
  name: "fs_write",
  description: "Write (create or overwrite) a UTF-8 text file within the workspace.",
  permission: "write",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace-relative file path." },
      content: { type: "string", description: "Full file contents to write." },
      createDirs: { type: "boolean", description: "Create parent directories (default true)." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const o = asObject(input);
    const rel = reqString(o, "path");
    const content = reqString(o, "content");
    const createDirs = o["createDirs"] === undefined ? true : o["createDirs"] === true;
    const abs = await resolveInWorkspace(ctx.cwd, rel);
    try {
      if (createDirs) await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, "utf8");
      return okText(`wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}`);
    } catch (err) {
      return errText(`write failed: ${rel} (${errnoCode(err) ?? "error"})`);
    }
  },
};

// ---------------------------------------------------------------------------
// fs_search (glob + grep)
// ---------------------------------------------------------------------------

export const fsSearchTool: Tool = {
  name: "fs_search",
  description:
    "Find files by glob and/or grep their contents by regex, within the workspace.",
  permission: "read",
  parameters: {
    type: "object",
    properties: {
      glob: { type: "string", description: "Glob over workspace paths, e.g. src/**/*.ts." },
      pattern: { type: "string", description: "Regex to match line contents." },
      flags: { type: "string", description: "Regex flags for pattern (default none)." },
      maxResults: { type: "number", description: "Cap on returned rows (default 200)." },
      ignore: { type: "array", items: { type: "string" }, description: "Extra dir names to skip." },
      searchDeadlineMs: {
        type: "number",
        description: `Wall-clock budget for the grep pass, guarding against catastrophic regexes (default ${DEFAULT_SEARCH_DEADLINE_MS}).`,
      },
    },
    additionalProperties: false,
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const o = asObject(input);
    const glob = o["glob"];
    const pattern = o["pattern"];
    const flags = o["flags"];
    const maxResults = optNumber(o, "maxResults") ?? 200;
    const extraIgnore = optStringArray(o, "ignore") ?? [];
    const deadlineMs = optNumber(o, "searchDeadlineMs") ?? DEFAULT_SEARCH_DEADLINE_MS;

    if (glob !== undefined && typeof glob !== "string") return errText(`"glob" must be a string`);
    if (pattern !== undefined && typeof pattern !== "string") return errText(`"pattern" must be a string`);
    if (flags !== undefined && typeof flags !== "string") return errText(`"flags" must be a string`);
    if (glob === undefined && pattern === undefined) {
      return errText(`fs_search requires at least one of "glob" or "pattern"`);
    }
    if (typeof pattern === "string" && pattern.length > MAX_PATTERN_LENGTH) {
      return errText(`pattern too long (max ${MAX_PATTERN_LENGTH} chars, possible catastrophic regex)`);
    }

    const ignore = new Set<string>([...DEFAULT_IGNORE, ...extraIgnore]);
    const globRe = typeof glob === "string" ? globToRegExp(glob) : undefined;

    let contentRe: RegExp | undefined;
    if (typeof pattern === "string") {
      try {
        contentRe = new RegExp(pattern, typeof flags === "string" ? flags : undefined);
      } catch (err) {
        return errText(`invalid regex: ${(err as Error).message}`);
      }
    }

    const files = await walkFiles(ctx.cwd, { ignore });
    const candidates = globRe ? files.filter((f) => globRe.test(f)) : files;

    // Glob-only mode: return the matching file list.
    if (!contentRe) {
      const shown = candidates.slice(0, maxResults);
      const body = shown.length ? shown.join("\n") : "(no files match)";
      const suffix = candidates.length > shown.length ? `\n[+${candidates.length - shown.length} more]` : "";
      return okText(body + suffix);
    }

    // Grep mode: scan candidate file contents, bounded by a wall-clock deadline
    // checked before every file and every line — a catastrophic pattern
    // (e.g. `(a+)+$`) aborts the search instead of hanging the event loop.
    const deadlineAt = Date.now() + deadlineMs;
    const rows: string[] = [];
    for (const rel of candidates) {
      if (rows.length >= maxResults) break;
      if (Date.now() >= deadlineAt) return searchTimeout(rows);
      let text: string;
      try {
        text = await fs.readFile(await resolveInWorkspace(ctx.cwd, rel), "utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (rows.length >= maxResults) break;
        if (Date.now() >= deadlineAt) return searchTimeout(rows);
        // Reset lastIndex for global patterns before each test.
        contentRe.lastIndex = 0;
        if (contentRe.test(lines[i]!)) rows.push(`${rel}:${i + 1}:${lines[i]!}`);
      }
    }

    const body = rows.length ? rows.join("\n") : "(no matches)";
    const suffix = rows.length >= maxResults ? `\n[results capped at ${maxResults}]` : "";
    return okText(body + suffix);
  },
};

/** Build the timeout `ToolResult`, preserving whatever partial matches were found. */
function searchTimeout(rows: string[]): ToolResult {
  const partial = rows.length ? `\n--- partial matches before timeout ---\n${rows.join("\n")}` : "";
  return {
    ok: false,
    isError: true,
    content: [textBlock(`search timed out (possible catastrophic regex)${partial}`)],
  };
}
