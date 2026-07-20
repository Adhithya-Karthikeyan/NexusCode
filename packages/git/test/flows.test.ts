import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockAdapter } from "@nexuscode/provider-mock";
import {
  runGit,
  diff,
  log,
  explainDiff,
  reviewChanges,
  generateCommitMessage,
  generatePrDescription,
  semanticDiff,
  conflictAssist,
  lineChanges,
  parseConflicts,
  stripConflictMarkers,
} from "@nexuscode/git";

/**
 * The LLM-driven flows run against the deterministic offline MOCK provider.
 * The default `mock-fast` model echoes the prompt, so we can assert the flow
 * (a) sent the right, redacted context and (b) parsed the reply. Where a flow's
 * parsing logic matters, we script the mock's `transform` to return exactly the
 * structured output a real provider would, keeping the test deterministic.
 */
describe("@nexuscode/git — LLM flows against the mock provider", () => {
  const mock = createMockAdapter();

  it("explainDiff returns a natural-language string built from the diff", async () => {
    const patch = "diff --git a/x.ts b/x.ts\n+export const answer = 42;\n";
    const out = await explainDiff(mock, patch);
    expect(out).toContain("[mock-fast] Echo:");
    expect(out).toContain("Explain the following git diff");
    expect(out).toContain("answer = 42");
  });

  it("explainDiff streams deltas via onDelta and they reconstruct the result", async () => {
    let streamed = "";
    const out = await explainDiff(mock, "diff --git a/y b/y\n+hi\n", {
      onDelta: (t) => {
        streamed += t;
      },
    });
    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed).toBe(out);
  });

  it("reviewChanges parses structured JSON from the provider", async () => {
    const scripted = createMockAdapter({
      transform: () =>
        JSON.stringify({
          summary: "Looks mostly good.",
          comments: [
            { severity: "warning", file: "x.ts", line: 3, message: "Missing null check." },
            { severity: "info", message: "Consider a test." },
          ],
        }),
    });
    const result = await reviewChanges(scripted, "diff --git a/x.ts b/x.ts\n+foo\n");
    expect(result.summary).toBe("Looks mostly good.");
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]).toMatchObject({
      severity: "warning",
      file: "x.ts",
      line: 3,
    });
    expect(result.comments[1]?.severity).toBe("info");
  });

  it("reviewChanges falls back to a single comment when output is not JSON", async () => {
    const result = await reviewChanges(mock, "diff --git a/x b/x\n+z\n");
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.severity).toBe("info");
    expect(result.raw).toContain("[mock-fast] Echo:");
  });

  it("generateCommitMessage parses a Conventional Commit", async () => {
    const scripted = createMockAdapter({
      transform: () => "feat(core)!: add streaming git flows\n\nExplain the change in the body.",
    });
    const msg = await generateCommitMessage(scripted, "diff --git a/a b/a\n+x\n");
    expect(msg.type).toBe("feat");
    expect(msg.scope).toBe("core");
    expect(msg.breaking).toBe(true);
    expect(msg.subject).toBe("add streaming git flows");
    expect(msg.body).toContain("Explain the change");
    expect(msg.header).toBe("feat(core)!: add streaming git flows");
  });

  it("generatePrDescription splits title from body", async () => {
    const scripted = createMockAdapter({
      transform: () => "Add git intelligence package\n\n## Summary\n- context helpers\n- LLM flows",
    });
    const pr = await generatePrDescription(scripted, {
      commits: [
        { hash: "a".repeat(40), author: "x", email: "x@y", date: "d", subject: "feat: a", body: "" },
      ],
      diff: "diff --git a/a b/a\n+x\n",
    });
    expect(pr.title).toBe("Add git intelligence package");
    expect(pr.body).toContain("## Summary");
    expect(pr.body).toContain("- context helpers");
  });

  it("semanticDiff computes line changes and summarizes them", async () => {
    const before = "const a = 1;\nfunction old() {}\n";
    const after = "const a = 1;\nfunction renamed() {}\n";
    const result = await semanticDiff(mock, before, after);
    expect(result.changes.removed).toContain("function old() {}");
    expect(result.changes.added).toContain("function renamed() {}");
    expect(result.summary).toContain("[mock-fast] Echo:");
    expect(result.summary).toContain("function renamed() {}");
  });

  it("conflictAssist parses conflict hunks and returns a suggestion", async () => {
    const conflicted =
      "keep\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> feature\ntail\n";
    const result = await conflictAssist(mock, conflicted);
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.ours).toBe("ours line");
    expect(result.hunks[0]?.theirs).toBe("theirs line");
    expect(result.resolution).toContain("[mock-fast] Echo:");
  });

  it("NEVER leaks a secret: diff content is redacted before reaching the provider", async () => {
    // A mock whose transform returns the exact prompt body it received, so we
    // can inspect precisely what the flow sent to the provider.
    const echoPrompt = createMockAdapter({ transform: (p) => p });
    const secret = "sk-ABCDEFGHIJKLMNOP1234567890";
    const patch = `diff --git a/config b/config\n+const key = "${secret}";\n`;
    const sent = await explainDiff(echoPrompt, patch);
    expect(sent).not.toContain(secret);
    expect(sent).toContain("[REDACTED]");
    // The rest of the (non-secret) diff structure is preserved.
    expect(sent).toContain("diff --git");
  });

  it("pure helpers: lineChanges / parseConflicts / stripConflictMarkers", () => {
    const lc = lineChanges("a\nb\nc", "a\nc\nd");
    expect(lc.removed).toContain("b");
    expect(lc.added).toContain("d");

    const hunks = parseConflicts("<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n");
    expect(hunks).toEqual([{ ours: "x", theirs: "y" }]);

    const stripped = stripConflictMarkers("a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\nz");
    expect(stripped).toBe("a\nx\ny\nz");
  });
});

/**
 * End-to-end: gather real git context from a temp repo via execFile, then feed
 * it to a flow — proving the two layers compose without a network or a shell.
 */
describe("@nexuscode/git — context feeds a flow end to end", () => {
  let repo: string;
  const g = (args: string[]) => runGit(args, { cwd: repo });

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "nexus-git-e2e-"));
    await g(["-c", "init.defaultBranch=main", "init"]);
    await g(["config", "user.email", "test@nexuscode.dev"]);
    await g(["config", "user.name", "NexusCode Test"]);
    await g(["config", "commit.gpgsign", "false"]);
    await writeFile(join(repo, "app.ts"), "export const version = 1;\n");
    await g(["add", "."]);
    await g(["commit", "-m", "feat: init app"]);
    await writeFile(join(repo, "app.ts"), "export const version = 2;\n");
  });

  afterAll(async () => {
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  it("real diff -> generateCommitMessage produces a message referencing the change", async () => {
    const patch = await diff({ cwd: repo });
    expect(patch).toContain("version = 2");
    const mock = createMockAdapter();
    const msg = await generateCommitMessage(mock, patch);
    expect(msg.message).toContain("version = 2");
    expect(msg.header.length).toBeGreaterThan(0);
  });

  it("real log -> generatePrDescription produces a title", async () => {
    const commits = await log({ cwd: repo, maxCount: 5 });
    const scripted = createMockAdapter({ transform: () => "PR: init app\n\nbody here" });
    const pr = await generatePrDescription(scripted, { commits });
    expect(pr.title).toBe("PR: init app");
    expect(pr.body).toBe("body here");
  });
});
