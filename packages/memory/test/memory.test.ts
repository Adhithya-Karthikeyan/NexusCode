import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:os";
import { statSync } from "node:fs";
import { openMemory } from "../src/store.js";
import { ingestInstructionFiles, instructionId } from "../src/ingest.js";
import { estimateTokens, lexicalScore, tokenize } from "../src/score.js";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

let clock = 1_000;
const now = (): number => (clock += 1000);

describe("scoring utilities", () => {
  it("tokenizes to lowercase words of length >= 2", () => {
    expect(tokenize("Hello, a WORLD-42!")).toEqual(["hello", "world", "42"]);
  });

  it("estimates tokens from chars and words", () => {
    expect(estimateTokens("")).toBe(0);
    // 12 chars → ceil(12/4)=3 ; 3 words → max = 3
    expect(estimateTokens("aaaa bbbb cc")).toBe(3);
  });

  it("scores term overlap and returns 0 for no match", () => {
    const base = { id: "1", tier: "long" as const, kind: "note", createdAt: 0, updatedAt: 0 };
    expect(lexicalScore("cats", { ...base, text: "dogs only" })).toBe(0);
    expect(lexicalScore("cats", { ...base, text: "cats cats" })).toBeGreaterThan(0);
  });
});

describe("MemoryStore — three tiers & CRUD", () => {
  it("puts/gets/updates/deletes across tiers and stamps timestamps", () => {
    clock = 1000;
    const store = openMemory({ file: ":memory:", now });

    const a = store.put({ tier: "long", kind: "preference", text: "prefers tabs" });
    expect(a.createdAt).toBe(a.updatedAt);
    expect(store.get(a.id)?.text).toBe("prefers tabs");

    const beforeUpdate = a.updatedAt;
    const updated = store.update(a.id, { text: "prefers spaces" });
    expect(updated.text).toBe("prefers spaces");
    expect(updated.createdAt).toBe(a.createdAt); // createdAt preserved
    expect(updated.updatedAt).toBeGreaterThan(beforeUpdate); // restamped

    store.put({ tier: "knowledge", kind: "decision", text: "use SQLite" });
    store.put({ tier: "short", kind: "conversation", text: "hi" });

    expect(store.list({ tier: "long" })).toHaveLength(1);
    expect(store.list({ tier: "knowledge" })).toHaveLength(1);
    expect(store.list({ tier: "short" })).toHaveLength(1);
    expect(store.list()).toHaveLength(3);

    expect(store.delete(a.id)).toBe(true);
    expect(store.get(a.id)).toBeUndefined();
    expect(store.delete("nope")).toBe(false);
  });

  it("upserts by explicit id preserving createdAt", () => {
    clock = 1000;
    const store = openMemory({ file: ":memory:", now });
    const first = store.put({ tier: "long", kind: "note", text: "v1", id: "fixed" });
    const second = store.put({ tier: "long", kind: "note", text: "v2", id: "fixed" });
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(store.list({ tier: "long" })).toHaveLength(1);
    expect(store.get("fixed")?.text).toBe("v2");
  });

  it("filters list by kind, tag and source", () => {
    const store = openMemory({ file: ":memory:", now });
    store.put({ tier: "long", kind: "command", text: "git status", tags: ["git"], source: "shell" });
    store.put({ tier: "long", kind: "preference", text: "dark mode", tags: ["ui"], source: "cfg" });
    expect(store.list({ kind: "command" })).toHaveLength(1);
    expect(store.list({ tag: "ui" })).toHaveLength(1);
    expect(store.list({ source: "shell" })).toHaveLength(1);
    expect(store.list({ tag: "nonexistent" })).toHaveLength(0);
  });
});

describe("MemoryStore — short tier conveniences", () => {
  it("records conversation turns and manages a scratchpad", () => {
    clock = 1000;
    const store = openMemory({ file: ":memory:", now, sessionId: "sess-1" });
    store.recordTurn("user", "what is 2+2");
    store.recordTurn("assistant", "4");
    const turns = store.turns();
    expect(turns).toHaveLength(2);
    expect(turns[0]?.tags).toContain("role:user");
    expect(turns[0]?.source).toBe("sess-1");

    expect(store.scratchpad()).toBeUndefined();
    store.setScratchpad("draft plan A");
    expect(store.scratchpad()).toBe("draft plan A");
    store.setScratchpad("draft plan B");
    expect(store.scratchpad()).toBe("draft plan B");
    // scratchpad stays a singleton
    expect(store.list({ tier: "short", kind: "scratchpad" })).toHaveLength(1);
  });
});

describe("MemoryStore — search & recall ranking", () => {
  it("ranks by relevance and excludes non-matches", () => {
    const store = openMemory({ file: ":memory:", now });
    store.put({ tier: "knowledge", kind: "document", text: "the cat sat on the mat" });
    store.put({ tier: "knowledge", kind: "document", text: "cat cat cat everywhere", tags: ["cat"] });
    store.put({ tier: "knowledge", kind: "document", text: "completely unrelated dogs" });

    const hits = store.search("cat");
    expect(hits).toHaveLength(2); // the dog doc is excluded
    // The tagged, higher-frequency doc ranks first (lexical: no stemming).
    expect(hits[0]?.item.text).toContain("cat cat cat");
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it("recall packs the most relevant items under a token budget", () => {
    const store = openMemory({ file: ":memory:", now });
    store.put({ tier: "knowledge", kind: "document", text: "alpha ".repeat(50) }); // large, relevant
    store.put({ tier: "knowledge", kind: "document", text: "alpha beta" }); // small, relevant
    store.put({ tier: "knowledge", kind: "document", text: "zzz nothing" }); // irrelevant

    const big = store.recall("alpha", 1000);
    expect(big.map((i) => i.text)).toContain("alpha beta");
    expect(big).toHaveLength(2);

    // Tiny budget: the large item does not fit, the small relevant one does.
    const tiny = store.recall("alpha", 3);
    expect(tiny).toHaveLength(1);
    expect(tiny[0]?.text).toBe("alpha beta");

    expect(store.recall("alpha", 0)).toHaveLength(0);
  });

  it("respects a custom scorer seam (embeddings-ready)", () => {
    // Reverse scorer: rank by text length ascending via negative length.
    const store = openMemory({
      file: ":memory:",
      now,
      scorer: (_q, item) => 1 / (item.text.length + 1),
    });
    store.put({ tier: "long", kind: "note", text: "short" });
    store.put({ tier: "long", kind: "note", text: "a much longer note here" });
    const hits = store.search("anything");
    expect(hits[0]?.item.text).toBe("short");
  });
});

describe("MemoryStore — persistence round-trip", () => {
  it("persists durable tiers and reloads them; short tier is not persisted", () => {
    const dir = tmp("nx-mem-persist-");
    clock = 1000;
    const s1 = openMemory({ dir, now });
    s1.put({ tier: "long", kind: "preference", text: "2-space indent", id: "p1" });
    s1.put({ tier: "knowledge", kind: "decision", text: "monorepo", id: "k1" });
    s1.recordTurn("user", "ephemeral");

    const s2 = openMemory({ dir, now });
    expect(s2.get("p1")?.text).toBe("2-space indent");
    expect(s2.get("k1")?.text).toBe("monorepo");
    expect(s2.list({ tier: "short" })).toHaveLength(0); // short tier gone

    // Update persists too.
    s2.update("p1", { text: "4-space indent" });
    const s3 = openMemory({ dir, now });
    expect(s3.get("p1")?.text).toBe("4-space indent");
  });

  it("writes the file atomically with restrictive perms and valid JSON", () => {
    const dir = tmp("nx-mem-perms-");
    const store = openMemory({ dir, now });
    store.put({ tier: "long", kind: "note", text: "x" });
    const file = store.path!;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed.version).toBe(1);
    expect(Array.isArray(parsed.items.long)).toBe(true);
    if (platform() !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("survives a corrupt persistence file by starting empty", () => {
    const dir = tmp("nx-mem-corrupt-");
    writeFileSync(join(dir, "memory.json"), "{ not valid json", "utf8");
    const store = openMemory({ dir, now });
    expect(store.list()).toHaveLength(0);
  });

  it("honors NEXUS_DATA_DIR from the environment", () => {
    const dir = tmp("nx-mem-env-");
    const store = openMemory({ env: { NEXUS_DATA_DIR: dir } as NodeJS.ProcessEnv, now });
    expect(store.path).toBe(join(dir, "memory.json"));
  });
});

describe("hierarchical instruction ingestion", () => {
  function scaffold(): { root: string; project: string } {
    const root = tmp("nx-mem-ingest-");
    // root (global-ish) has its own CLAUDE.md and .nexus/memory
    writeFileSync(join(root, "CLAUDE.md"), "ROOT rules: be terse", "utf8");
    mkdirSync(join(root, ".nexus"), { recursive: true });
    writeFileSync(join(root, ".nexus", "memory"), "root preference: verbose off", "utf8");
    // nested project dir overrides
    const project = join(root, "team", "app");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "CLAUDE.md"), "PROJECT rules: use vitest", "utf8");
    writeFileSync(join(project, "AGENTS.md"), "PROJECT agents: executor first", "utf8");
    return { root, project };
  }

  it("ingests CLAUDE.md/AGENTS.md into knowledge and .nexus/memory into long", () => {
    const { project } = scaffold();
    const store = openMemory({ file: ":memory:", now });
    const res = ingestInstructionFiles(store, { cwd: project, home: project, maxDepth: 8 });

    expect(res.items.length).toBeGreaterThanOrEqual(4);
    const knowledge = store.list({ tier: "knowledge", kind: "instruction" });
    const long = store.list({ tier: "long", kind: "instruction" });
    expect(knowledge.some((i) => i.text.includes("PROJECT rules"))).toBe(true);
    expect(knowledge.some((i) => i.text.includes("ROOT rules"))).toBe(true);
    expect(long.some((i) => i.text.includes("root preference"))).toBe(true);
    // sources are absolute file paths (auditable provenance)
    expect(knowledge.every((i) => typeof i.source === "string" && i.source.length > 0)).toBe(true);
  });

  it("ranks nearer (project) instructions above farther (global) ones", () => {
    const { root, project } = scaffold();
    // Put the same keyword in both scopes so ranking is decided by precedence.
    writeFileSync(join(root, "CLAUDE.md"), "policy: shared keyword", "utf8");
    writeFileSync(join(project, "CLAUDE.md"), "policy: shared keyword", "utf8");
    const store = openMemory({ file: ":memory:", now });
    ingestInstructionFiles(store, { cwd: project, home: project, maxDepth: 8 });

    const hits = store.search("policy keyword", { tier: "knowledge" });
    expect(hits.length).toBeGreaterThanOrEqual(2);
    // Project CLAUDE.md (nearest, precedence:0) outranks the root one.
    expect(hits[0]?.item.source).toBe(join(project, "CLAUDE.md"));
    const projTags = hits[0]?.item.tags ?? [];
    expect(projTags).toContain("precedence:0");
    expect(projTags).toContain("scope:project");
  });

  it("is idempotent: re-ingesting updates in place instead of duplicating", () => {
    const { project } = scaffold();
    clock = 1000;
    const store = openMemory({ file: ":memory:", now });
    ingestInstructionFiles(store, { cwd: project, home: project, maxDepth: 8 });
    const countAfterFirst = store.list({ kind: "instruction" }).length;
    const projClaude = join(project, "CLAUDE.md");
    const before = store.get(instructionId("knowledge", projClaude));

    // Change the file and re-ingest.
    writeFileSync(projClaude, "PROJECT rules: updated body", "utf8");
    ingestInstructionFiles(store, { cwd: project, home: project, maxDepth: 8 });

    const countAfterSecond = store.list({ kind: "instruction" }).length;
    expect(countAfterSecond).toBe(countAfterFirst); // no duplicates
    const after = store.get(instructionId("knowledge", projClaude));
    expect(after?.text).toBe("PROJECT rules: updated body");
    expect(after?.createdAt).toBe(before?.createdAt); // provenance preserved
    expect(after!.updatedAt).toBeGreaterThan(before!.updatedAt); // audit stamp advanced
  });

  it("expands .nexus/memory when it is a directory of files", () => {
    const root = tmp("nx-mem-dir-");
    mkdirSync(join(root, ".nexus", "memory"), { recursive: true });
    writeFileSync(join(root, ".nexus", "memory", "style.md"), "prefer const", "utf8");
    writeFileSync(join(root, ".nexus", "memory", "conventions.md"), "kebab-case files", "utf8");
    const store = openMemory({ file: ":memory:", now });
    ingestInstructionFiles(store, { cwd: root, home: root, maxDepth: 4 });
    const long = store.list({ tier: "long", kind: "instruction" });
    expect(long).toHaveLength(2);
    expect(long.map((i) => i.text).sort()).toEqual(["kebab-case files", "prefer const"]);
  });
});
