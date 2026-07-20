/**
 * `fs_patch` — apply a unified diff to the workspace. A real (dependency-free)
 * unified-diff parser + applier: multi-file patches, hunk context verification,
 * file creation (`--- /dev/null`) and deletion (`+++ /dev/null`). Context and
 * removed lines are verified against the current file so a stale or malformed
 * patch fails loudly instead of corrupting a file. All paths are confined to the
 * workspace root.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveInWorkspace, stripDiffPrefix } from "./paths.js";
import { errText, textBlock, type Tool, type ToolContext, type ToolResult } from "./types.js";
import { asObject, reqString } from "./validate.js";

interface Hunk {
  oldStart: number;
  newStart: number;
  lines: string[]; // each retains its leading ' ', '-', or '+'
}

interface FilePatch {
  oldPath: string;
  newPath: string;
  hunks: Hunk[];
}

/** Error thrown on a malformed or non-applying patch. */
export class PatchError extends Error {
  override readonly name = "PatchError";
}

/** Split file text into logical lines, dropping the trailing-newline artifact. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Parse a (possibly multi-file) unified diff into structured file patches. */
export function parseUnifiedDiff(diff: string): FilePatch[] {
  const lines = diff.split("\n");
  const patches: FilePatch[] = [];
  let current: FilePatch | undefined;
  let hunk: Hunk | undefined;

  const closeHunk = (): void => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.startsWith("--- ")) {
      closeHunk();
      const oldPath = line.slice(4).replace(/\t.*$/, "").trim();
      const next = lines[i + 1];
      if (next === undefined || !next.startsWith("+++ ")) {
        throw new PatchError(`malformed diff: "--- " header not followed by "+++ "`);
      }
      const newPath = next.slice(4).replace(/\t.*$/, "").trim();
      current = { oldPath, newPath, hunks: [] };
      patches.push(current);
      i++; // consume the +++ line
      continue;
    }

    if (line.startsWith("@@")) {
      if (!current) throw new PatchError(`hunk found before any file header`);
      closeHunk();
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!m) throw new PatchError(`malformed hunk header: ${line}`);
      hunk = { oldStart: Number(m[1]), newStart: Number(m[2]), lines: [] };
      continue;
    }

    if (!hunk) continue; // skip "diff --git", "index", and other preamble noise

    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+")) {
      hunk.lines.push(line);
      continue;
    }
    // A bare empty line has no unified-diff prefix (a blank context line is
    // " ", a blank added line is "+"); it is the terminating newline or a
    // separator, so it ends the current hunk region.
    closeHunk();
  }
  closeHunk();
  return patches;
}

/** Apply parsed hunks to `original` text, returning the new text. */
export function applyHunks(original: string, hunks: Hunk[]): string {
  const src = splitLines(original);
  const out: string[] = [];
  let cursor = 0; // 0-based index into src

  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - 1);
    if (start < cursor) {
      throw new PatchError(`overlapping or out-of-order hunk at line ${hunk.oldStart}`);
    }
    // Copy untouched lines before the hunk.
    while (cursor < start && cursor < src.length) out.push(src[cursor++]!);

    for (const l of hunk.lines) {
      const tag = l[0];
      const text = l.slice(1);
      if (tag === " ") {
        if (src[cursor] !== text) {
          throw new PatchError(
            `context mismatch at line ${cursor + 1}: expected ${JSON.stringify(text)}, found ${JSON.stringify(src[cursor])}`,
          );
        }
        out.push(text);
        cursor++;
      } else if (tag === "-") {
        if (src[cursor] !== text) {
          throw new PatchError(
            `remove mismatch at line ${cursor + 1}: expected ${JSON.stringify(text)}, found ${JSON.stringify(src[cursor])}`,
          );
        }
        cursor++;
      } else if (tag === "+") {
        out.push(text);
      }
    }
  }

  // Copy any remaining untouched tail.
  while (cursor < src.length) out.push(src[cursor++]!);

  // Preserve a trailing newline (the overwhelmingly common file shape).
  return out.length ? out.join("\n") + "\n" : "";
}

/**
 * Apply every file patch in `diff` against the workspace at `root`. Returns the
 * list of touched relative paths with their operation. Throws `PatchError` on
 * any failure, having attempted nothing destructive out of order (files are
 * written one at a time in patch order).
 */
export async function applyUnifiedDiff(
  root: string,
  diff: string,
): Promise<{ path: string; op: "create" | "modify" | "delete" }[]> {
  const patches = parseUnifiedDiff(diff);
  if (patches.length === 0) throw new PatchError("no file patches found in diff");

  const touched: { path: string; op: "create" | "modify" | "delete" }[] = [];

  for (const patch of patches) {
    const oldPath = stripDiffPrefix(patch.oldPath);
    const newPath = stripDiffPrefix(patch.newPath);
    const isCreate = oldPath === "/dev/null";
    const isDelete = newPath === "/dev/null";

    if (isDelete) {
      const absOld = await resolveInWorkspace(root, oldPath);
      await fs.rm(absOld, { force: true });
      touched.push({ path: oldPath, op: "delete" });
      continue;
    }

    const absNew = await resolveInWorkspace(root, newPath);
    let original = "";
    if (!isCreate) {
      try {
        original = await fs.readFile(absNew, "utf8");
      } catch {
        throw new PatchError(`target file not found for patch: ${newPath}`);
      }
    }

    const updated = applyHunks(original, patch.hunks);
    await fs.mkdir(path.dirname(absNew), { recursive: true });
    await fs.writeFile(absNew, updated, "utf8");
    touched.push({ path: newPath, op: isCreate ? "create" : "modify" });
  }

  return touched;
}

export const fsPatchTool: Tool = {
  name: "fs_patch",
  description: "Apply a unified diff (multi-file, create/modify/delete) to the workspace.",
  permission: "write",
  parameters: {
    type: "object",
    properties: {
      diff: { type: "string", description: "A unified diff as produced by `git diff`/`diff -u`." },
    },
    required: ["diff"],
    additionalProperties: false,
  },
  async run(input: unknown, ctx: ToolContext): Promise<ToolResult> {
    const o = asObject(input);
    const diff = reqString(o, "diff");
    try {
      const touched = await applyUnifiedDiff(ctx.cwd, diff);
      const summary = touched.map((t) => `${t.op}: ${t.path}`).join("\n");
      return { ok: true, content: [textBlock(`applied patch to ${touched.length} file(s)\n${summary}`)] };
    } catch (err) {
      if (err instanceof PatchError) return errText(`patch failed: ${err.message}`);
      throw err;
    }
  },
};
