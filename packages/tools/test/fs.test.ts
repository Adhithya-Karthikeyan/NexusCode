import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fsReadTool,
  fsWriteTool,
  fsSearchTool,
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
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "nc-fs-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("fs_write + fs_read", () => {
  it("writes and reads back a file, creating parent dirs", async () => {
    const w = await runTool(fsWriteTool, { path: "sub/a.txt", content: "hello\nworld\n" }, ctx());
    expect(w.ok).toBe(true);
    expect(textOf(w.content)).toMatch(/wrote \d+ bytes/);

    const r = await runTool(fsReadTool, { path: "sub/a.txt" }, ctx());
    expect(r.ok).toBe(true);
    expect(textOf(r.content)).toBe("hello\nworld\n");
  });

  it("fs_read returns an error result for a missing file", async () => {
    const r = await runTool(fsReadTool, { path: "nope.txt" }, ctx());
    expect(r.ok).toBe(false);
    expect(r.isError).toBe(true);
    expect(textOf(r.content)).toMatch(/not found/);
  });

  it("fs_read truncates at maxBytes", async () => {
    await runTool(fsWriteTool, { path: "big.txt", content: "0123456789" }, ctx());
    const r = await runTool(fsReadTool, { path: "big.txt", maxBytes: 4 }, ctx());
    expect(textOf(r.content)).toMatch(/^0123/);
    expect(textOf(r.content)).toMatch(/truncated/);
  });

  it("confines paths to the workspace (rejects traversal)", async () => {
    await expect(runTool(fsReadTool, { path: "../../etc/passwd" }, ctx())).rejects.toThrow(/escapes workspace/);
    await expect(runTool(fsWriteTool, { path: "/etc/evil", content: "x" }, ctx())).rejects.toThrow(/escapes workspace/);
  });

  it("refuses to follow a symlink that points OUTSIDE the workspace (read)", async () => {
    // Plant a secret outside the workspace and a symlink to it inside — the
    // exact shape a malicious repo or a prior `ln -s` would create.
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nc-secret-"));
    const secret = path.join(outside, "id_rsa");
    await fs.writeFile(secret, "TOP-SECRET-KEY\n");
    try {
      await fs.symlink(secret, path.join(dir, "link.txt"));
      await expect(runTool(fsReadTool, { path: "link.txt" }, ctx())).rejects.toThrow(/escapes workspace/);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses to write THROUGH a symlinked directory that escapes the workspace", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nc-out-"));
    try {
      // `escape/` inside the workspace is a symlink to a dir outside it.
      await fs.symlink(outside, path.join(dir, "escape"));
      await expect(
        runTool(fsWriteTool, { path: "escape/pwned.txt", content: "x" }, ctx()),
      ).rejects.toThrow(/escapes workspace/);
      // Nothing was written through the symlink.
      await expect(fs.access(path.join(outside, "pwned.txt"))).rejects.toThrow();
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("still allows normal symlinks that stay INSIDE the workspace", async () => {
    await fs.writeFile(path.join(dir, "real.txt"), "inside\n");
    await fs.symlink(path.join(dir, "real.txt"), path.join(dir, "alias.txt"));
    const r = await runTool(fsReadTool, { path: "alias.txt" }, ctx());
    expect(r.ok).toBe(true);
    expect(textOf(r.content)).toBe("inside\n");
  });

  it("rejects malformed input", async () => {
    await expect(runTool(fsReadTool, { path: 123 }, ctx())).rejects.toThrow(/must be a string/);
    await expect(runTool(fsWriteTool, { path: "a" }, ctx())).rejects.toThrow(/content/);
  });
});

describe("fs_search", () => {
  beforeEach(async () => {
    await fs.mkdir(path.join(dir, "src"), { recursive: true });
    await fs.writeFile(path.join(dir, "src", "a.ts"), "export const x = 1;\nconst secret = 2;\n");
    await fs.writeFile(path.join(dir, "src", "b.ts"), "import { x } from './a';\n");
    await fs.writeFile(path.join(dir, "readme.md"), "hello\n");
    await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(dir, "node_modules", "pkg", "index.ts"), "junk\n");
  });

  it("lists files by glob and skips ignored dirs", async () => {
    const r = await runTool(fsSearchTool, { glob: "src/**/*.ts" }, ctx());
    const body = textOf(r.content);
    expect(body).toContain("src/a.ts");
    expect(body).toContain("src/b.ts");
    expect(body).not.toContain("node_modules");
    expect(body).not.toContain("readme.md");
  });

  it("greps file contents by regex with file:line prefix", async () => {
    const r = await runTool(fsSearchTool, { glob: "src/**/*.ts", pattern: "const\\s+\\w+" }, ctx());
    const body = textOf(r.content);
    expect(body).toContain("src/a.ts:1:export const x = 1;");
    expect(body).toContain("src/a.ts:2:const secret = 2;");
  });

  it("requires at least one of glob or pattern", async () => {
    const r = await runTool(fsSearchTool, {}, ctx());
    expect(r.isError).toBe(true);
    expect(textOf(r.content)).toMatch(/at least one/);
  });

  it("reports an invalid regex as an error result", async () => {
    const r = await runTool(fsSearchTool, { pattern: "(" }, ctx());
    expect(r.isError).toBe(true);
    expect(textOf(r.content)).toMatch(/invalid regex/);
  });

  it("aborts with a timeout instead of hanging on a pathological pattern (short deadline)", async () => {
    // A classic catastrophic-backtracking pattern against adversarial input —
    // with no protection this would hang the event loop indefinitely.
    await fs.writeFile(path.join(dir, "evil.txt"), `${"a".repeat(40)}!\n`);
    const start = Date.now();
    const r = await runTool(
      fsSearchTool,
      { pattern: "(a+)+$", glob: "evil.txt", searchDeadlineMs: 0 },
      ctx(),
    );
    expect(Date.now() - start).toBeLessThan(1000);
    expect(r.isError).toBe(true);
    expect(textOf(r.content)).toMatch(/search timed out/);
  }, 5_000);

  it("rejects an over-long pattern outright (defense-in-depth)", async () => {
    const r = await runTool(fsSearchTool, { pattern: "a".repeat(600) }, ctx());
    expect(r.isError).toBe(true);
    expect(textOf(r.content)).toMatch(/too long/);
  });
});
