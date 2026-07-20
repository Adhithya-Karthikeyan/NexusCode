import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runGit,
  isGitRepo,
  repoRoot,
  status,
  diff,
  log,
  branch,
  currentBranch,
  blame,
} from "@nexuscode/git";

/**
 * These tests exercise the git-context helpers against a REAL, temporary git
 * repository created inside the test (git is available in the environment).
 * Nothing here touches the network or a provider.
 */
describe("@nexuscode/git — context helpers on a temp repo", () => {
  let repo: string;

  const g = (args: string[]) => runGit(args, { cwd: repo });

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "nexus-git-ctx-"));
    // Deterministic default branch + identity so commits succeed headlessly.
    await g(["-c", "init.defaultBranch=main", "init"]);
    await g(["config", "user.email", "test@nexuscode.dev"]);
    await g(["config", "user.name", "NexusCode Test"]);
    await g(["config", "commit.gpgsign", "false"]);

    await writeFile(join(repo, "hello.txt"), "line one\nline two\nline three\n");
    await writeFile(join(repo, "keep.txt"), "unchanged\n");
    await g(["add", "."]);
    await g(["commit", "-m", "feat: initial commit"]);

    // A second commit so `log` has history and blame has two authors of lines.
    await writeFile(join(repo, "hello.txt"), "line one\nline two changed\nline three\nline four\n");
    await g(["add", "hello.txt"]);
    await g(["commit", "-m", "fix: adjust hello contents"]);
  });

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("isGitRepo is true inside the repo and repoRoot resolves", async () => {
    expect(await isGitRepo({ cwd: repo })).toBe(true);
    const root = await repoRoot({ cwd: repo });
    // macOS tmpdir may be symlinked (/var → /private/var); compare basenames.
    expect(root.length).toBeGreaterThan(0);
    expect(root.split("/").pop()).toBe(repo.split("/").pop());
  });

  it("isGitRepo is false outside any repo", async () => {
    const outside = await mkdtemp(join(tmpdir(), "nexus-not-git-"));
    try {
      expect(await isGitRepo({ cwd: outside })).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("branch / currentBranch report the checked-out branch", async () => {
    expect(await currentBranch({ cwd: repo })).toBe("main");
    const info = await branch({ cwd: repo });
    expect(info.current).toBe("main");
    expect(info.all).toContain("main");
  });

  it("status is clean with no pending changes, dirty after an edit", async () => {
    const clean = await status({ cwd: repo });
    expect(clean.clean).toBe(true);
    expect(clean.files).toHaveLength(0);
    expect(clean.branch).toBe("main");

    await writeFile(join(repo, "hello.txt"), "line one\nMUTATED\nline three\nline four\n");
    await writeFile(join(repo, "brand-new.txt"), "fresh\n");

    const dirty = await status({ cwd: repo });
    expect(dirty.clean).toBe(false);
    const paths = dirty.files.map((f) => f.path);
    expect(paths).toContain("hello.txt");
    expect(paths).toContain("brand-new.txt");

    const untracked = dirty.files.find((f) => f.path === "brand-new.txt");
    expect(untracked?.untracked).toBe(true);

    // Restore the working tree for the diff test below.
    await g(["checkout", "--", "hello.txt"]);
    await rm(join(repo, "brand-new.txt"));
  });

  it("diff returns a real unified patch for an unstaged change", async () => {
    await writeFile(join(repo, "hello.txt"), "line one\nDIFFED\nline three\nline four\n");
    const patch = await diff({ cwd: repo });
    expect(patch).toContain("diff --git");
    expect(patch).toContain("hello.txt");
    expect(patch).toContain("+DIFFED");
    expect(patch).toContain("-line two changed");

    // staged diff is empty until we stage; then it carries the change.
    expect(await diff({ cwd: repo, staged: true })).toBe("");
    await g(["add", "hello.txt"]);
    const staged = await diff({ cwd: repo, staged: true });
    expect(staged).toContain("+DIFFED");

    await g(["checkout", "--", "hello.txt"]);
    await g(["reset", "--hard", "HEAD"]);
  });

  it("log parses commit history into typed entries", async () => {
    const entries = await log({ cwd: repo, maxCount: 10 });
    expect(entries.length).toBeGreaterThanOrEqual(2);
    const subjects = entries.map((e) => e.subject);
    expect(subjects).toContain("feat: initial commit");
    expect(subjects).toContain("fix: adjust hello contents");
    for (const e of entries) {
      expect(e.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(e.author).toBe("NexusCode Test");
      expect(e.email).toBe("test@nexuscode.dev");
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("blame attributes each line to a commit and author", async () => {
    const lines = await blame({ cwd: repo, file: "hello.txt" });
    expect(lines.length).toBe(4);
    expect(lines[0]?.line).toBe(1);
    expect(lines[0]?.content).toBe("line one");
    for (const l of lines) {
      expect(l.hash).toMatch(/^[0-9a-f]{40}$/);
      expect(l.author).toBe("NexusCode Test");
    }
  });

  it("runGit surfaces a non-zero exit as a result, not a throw", async () => {
    const r = await runGit(["rev-parse", "--verify", "definitely-not-a-ref"], { cwd: repo });
    expect(r.ok).toBe(false);
    expect(r.exitCode).not.toBe(0);
  });

  it("diff/log reject an option-injection ref instead of passing it to git", async () => {
    const pwned = join(tmpdir(), `nexus-git-pwned-${Date.now()}.txt`);
    await expect(diff({ cwd: repo, ref: "--output=" + pwned })).rejects.toThrow(/invalid git ref/);
    await expect(log({ cwd: repo, ref: "--output=" + pwned })).rejects.toThrow(/invalid git ref/);
    // The injected git option must never have actually run.
    expect(existsSync(pwned)).toBe(false);

    // A normal, legitimate ref still works for both.
    const patch = await diff({ cwd: repo, ref: "HEAD~1" });
    expect(patch).toContain("diff --git");
    const entries = await log({ cwd: repo, ref: "HEAD~1..HEAD" });
    expect(entries.length).toBe(1);
    expect(entries[0]?.subject).toBe("fix: adjust hello contents");
  });
});
