import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { openMemory } from "@nexuscode/memory";
import {
  ConversationHistorySource,
  CurrentTaskSource,
  EnvSource,
  GitDiffSource,
  MemorySource,
  ProjectFilesSource,
  TerminalOutputSource,
  defaultEstimator,
  type CollectContext,
} from "@nexuscode/context";

function ctx(overrides: Partial<CollectContext> = {}): CollectContext {
  return {
    userMessage: "how do I use the parser",
    cwd: process.cwd(),
    now: 1000,
    estimate: defaultEstimator,
    ...overrides,
  };
}

describe("ConversationHistorySource", () => {
  it("emits history-lane chunks from provided turns, respecting maxTurns", async () => {
    const src = new ConversationHistorySource({
      turns: [
        { role: "user", text: "one", ts: 1 },
        { role: "assistant", text: "two", ts: 2 },
        { role: "user", text: "three", ts: 3 },
      ],
      maxTurns: 2,
    });
    const chunks = await src.collect(ctx());
    expect(chunks.map((c) => c.text)).toEqual(["two", "three"]);
    expect(chunks.every((c) => c.lane === "history")).toBe(true);
    expect(chunks[1]!.role).toBe("user");
  });

  it("pulls turns from a MemoryStore short tier", async () => {
    let clock = 0;
    const mem = openMemory({ file: ":memory:", now: () => ++clock });
    mem.recordTurn("user", "first question");
    mem.recordTurn("assistant", "an answer");
    const src = new ConversationHistorySource({ store: mem });
    const chunks = await src.collect(ctx());
    expect(chunks.map((c) => c.text)).toEqual(["first question", "an answer"]);
    expect(chunks[0]!.role).toBe("user");
    expect(chunks[1]!.role).toBe("assistant");
  });
});

describe("CurrentTaskSource", () => {
  it("emits a pinned task chunk and skips empty tasks", async () => {
    const chunks = await new CurrentTaskSource({ task: "  fix the bug  " }).collect(ctx());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.lane).toBe("task");
    expect(chunks[0]!.pinned).toBe(true);
    expect(chunks[0]!.text).toBe("fix the bug");
    expect(await new CurrentTaskSource({ task: "   " }).collect(ctx())).toHaveLength(0);
  });
});

describe("EnvSource", () => {
  it("emits only requested keys, sorted, with secret masking", async () => {
    const chunks = await new EnvSource({
      keys: ["ZED", "API_KEY", "PATH"],
      env: { ZED: "z", API_KEY: "sk-supersecret", PATH: "/usr/bin", UNUSED: "x" },
    }).collect(ctx());
    expect(chunks).toHaveLength(1);
    const text = chunks[0]!.text;
    // Sorted: API_KEY, PATH, ZED.
    expect(text).toBe("API_KEY=***\nPATH=/usr/bin\nZED=z");
    expect(chunks[0]!.lane).toBe("env");
  });

  it("can disable redaction", async () => {
    const chunks = await new EnvSource({
      keys: ["TOKEN"],
      env: { TOKEN: "abc123" },
      redact: false,
    }).collect(ctx());
    expect(chunks[0]!.text).toBe("TOKEN=abc123");
  });
});

describe("TerminalOutputSource", () => {
  it("tail-preserves oversized output", async () => {
    const output = "HEAD LINE\n" + "middle\n".repeat(200) + "FINAL ERROR LINE";
    const chunks = await new TerminalOutputSource({
      entries: [{ command: "npm test", output }],
      maxTokensPerEntry: 20,
    }).collect(ctx());
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.lane).toBe("terminal");
    expect(chunks[0]!.text).toContain("$ npm test");
    // The tail (final error) is preserved; the head is dropped.
    expect(chunks[0]!.text).toContain("FINAL ERROR LINE");
    expect(chunks[0]!.text.length).toBeLessThan(output.length);
  });
});

describe("GitDiffSource", () => {
  it("emits status + diff chunks via an injected runner", async () => {
    const runner = async (args: string[]) => {
      if (args[0] === "status") return " M src/a.ts\n?? new.ts\n";
      if (args[0] === "diff") return "diff --git a/src/a.ts b/src/a.ts\n+added line\n";
      return "";
    };
    const chunks = await new GitDiffSource({ run: runner }).collect(ctx());
    const ids = chunks.map((c) => c.id);
    expect(ids).toContain("git:status");
    expect(ids).toContain("git:diff");
    expect(chunks.every((c) => c.lane === "git")).toBe(true);
  });

  it("emits nothing when there are no changes", async () => {
    const chunks = await new GitDiffSource({ run: async () => "" }).collect(ctx());
    expect(chunks).toHaveLength(0);
  });
});

describe("MemorySource", () => {
  it("recalls relevant items into the retrieved lane, ranked", async () => {
    const mem = openMemory({ file: ":memory:" });
    mem.put({ tier: "long", kind: "convention", text: "the parser uses recursive descent" });
    mem.put({ tier: "knowledge", kind: "document", text: "unrelated note about billing" });
    const src = new MemorySource({ store: mem });
    const chunks = await src.collect(ctx({ userMessage: "parser internals" }));
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.lane).toBe("retrieved");
    expect(chunks[0]!.text).toContain("parser");
    // Ranked: first item carries the highest relevance.
    if (chunks.length > 1) {
      expect(chunks[0]!.relevance!).toBeGreaterThanOrEqual(chunks[1]!.relevance!);
    }
  });

  it("uses the static memory lane when configured", async () => {
    const mem = openMemory({ file: ":memory:" });
    mem.put({ tier: "long", kind: "convention", text: "always run the build" });
    const src = new MemorySource({ store: mem, lane: "memory", query: "build" });
    expect(src.kind).toBe("static");
    const chunks = await src.collect(ctx());
    expect(chunks[0]!.lane).toBe("memory");
  });
});

describe("ProjectFilesSource — ignore rules", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-files-"));
    await fs.writeFile(path.join(dir, "keep.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(dir, "secret.env"), "TOKEN=xxx\n");
    await fs.mkdir(path.join(dir, "build"), { recursive: true });
    await fs.writeFile(path.join(dir, "build", "out.js"), "compiled\n");
    await fs.writeFile(path.join(dir, ".gitignore"), "*.env\nbuild/\n");
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("respects .gitignore patterns in the repo map", async () => {
    const src = new ProjectFilesSource({ root: dir });
    const chunks = await src.collect(ctx({ cwd: dir }));
    const tree = chunks.find((c) => c.id === "repo-map:tree")!;
    expect(tree.lane).toBe("repo-map");
    expect(tree.text).toContain("keep.ts");
    expect(tree.text).not.toContain("secret.env");
    expect(tree.text).not.toContain("out.js");
  });

  it("optionally includes file contents", async () => {
    const src = new ProjectFilesSource({ root: dir, contents: true, include: ["*.ts"] });
    const chunks = await src.collect(ctx({ cwd: dir }));
    const fileChunk = chunks.find((c) => c.id === "repo-file:keep.ts");
    expect(fileChunk).toBeDefined();
    expect(fileChunk!.text).toContain("export const a = 1;");
  });
});
