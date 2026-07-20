import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fsPatchTool,
  applyHunks,
  parseUnifiedDiff,
  applyUnifiedDiff,
  runTool,
  type ToolContext,
} from "@nexuscode/tools";

let dir: string;
function ctx(): ToolContext {
  return { signal: new AbortController().signal, cwd: dir };
}
function textOf(content: { type: string }[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nc-patch-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("applyHunks (pure)", () => {
  it("modifies a middle line, keeping context", () => {
    const original = "line1\nline2\nline3\n";
    const hunks = parseUnifiedDiff(
      ["--- a/f.txt", "+++ b/f.txt", "@@ -1,3 +1,3 @@", " line1", "-line2", "+CHANGED", " line3"].join("\n"),
    )[0]!.hunks;
    expect(applyHunks(original, hunks)).toBe("line1\nCHANGED\nline3\n");
  });

  it("throws on context mismatch", () => {
    const hunks = parseUnifiedDiff(
      ["--- a/f.txt", "+++ b/f.txt", "@@ -1,1 +1,1 @@", "-wrong", "+new"].join("\n"),
    )[0]!.hunks;
    expect(() => applyHunks("actual\n", hunks)).toThrow(/mismatch/);
  });
});

describe("fs_patch tool", () => {
  it("modifies an existing file", async () => {
    await fs.writeFile(path.join(dir, "f.txt"), "alpha\nbeta\ngamma\n");
    const diff = [
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    const r = await runTool(fsPatchTool, { diff }, ctx());
    expect(r.ok).toBe(true);
    expect(textOf(r.content)).toMatch(/modify: f\.txt/);
    expect(await fs.readFile(path.join(dir, "f.txt"), "utf8")).toBe("alpha\nBETA\ngamma\n");
  });

  it("creates a new file from /dev/null", async () => {
    const diff = ["--- /dev/null", "+++ b/new/created.txt", "@@ -0,0 +1,2 @@", "+one", "+two", ""].join("\n");
    const r = await runTool(fsPatchTool, { diff }, ctx());
    expect(r.ok).toBe(true);
    expect(textOf(r.content)).toMatch(/create: new\/created\.txt/);
    expect(await fs.readFile(path.join(dir, "new", "created.txt"), "utf8")).toBe("one\ntwo\n");
  });

  it("deletes a file to /dev/null", async () => {
    await fs.writeFile(path.join(dir, "gone.txt"), "bye\n");
    const diff = ["--- a/gone.txt", "+++ /dev/null", "@@ -1,1 +0,0 @@", "-bye", ""].join("\n");
    const r = await runTool(fsPatchTool, { diff }, ctx());
    expect(r.ok).toBe(true);
    expect(textOf(r.content)).toMatch(/delete: gone\.txt/);
    await expect(fs.access(path.join(dir, "gone.txt"))).rejects.toThrow();
  });

  it("applies a multi-file patch", async () => {
    await fs.writeFile(path.join(dir, "x.txt"), "x1\n");
    await fs.writeFile(path.join(dir, "y.txt"), "y1\n");
    const diff = [
      "--- a/x.txt",
      "+++ b/x.txt",
      "@@ -1,1 +1,1 @@",
      "-x1",
      "+x2",
      "--- a/y.txt",
      "+++ b/y.txt",
      "@@ -1,1 +1,1 @@",
      "-y1",
      "+y2",
      "",
    ].join("\n");
    const touched = await applyUnifiedDiff(dir, diff);
    expect(touched).toHaveLength(2);
    expect(await fs.readFile(path.join(dir, "x.txt"), "utf8")).toBe("x2\n");
    expect(await fs.readFile(path.join(dir, "y.txt"), "utf8")).toBe("y2\n");
  });

  it("returns an error result on a non-applying patch", async () => {
    await fs.writeFile(path.join(dir, "f.txt"), "real\n");
    const diff = ["--- a/f.txt", "+++ b/f.txt", "@@ -1,1 +1,1 @@", "-stale", "+new", ""].join("\n");
    const r = await runTool(fsPatchTool, { diff }, ctx());
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    expect(textOf(r.content)).toMatch(/patch failed/);
    // The stale target must be left untouched.
    expect(await fs.readFile(path.join(dir, "f.txt"), "utf8")).toBe("real\n");
  });

  it("confines patch targets to the workspace", async () => {
    const diff = ["--- /dev/null", "+++ b/../escape.txt", "@@ -0,0 +1,1 @@", "+x", ""].join("\n");
    // resolveInWorkspace throws a NexusError (not a PatchError) which propagates.
    await expect(runTool(fsPatchTool, { diff }, ctx())).rejects.toThrow(/escapes workspace/);
    await expect(fs.access(path.join(path.dirname(dir), "escape.txt"))).rejects.toThrow();
  });
});
