/**
 * ProjectConventionsSource — the static `conventions` lane fed by the project's
 * CLAUDE.md / AGENTS.md. Offline and deterministic: every case runs against a
 * temp tree with an explicit `home` so the developer's real home dir never
 * leaks into the assertions.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContextEngine, ProjectConventionsSource } from "../src/index.js";
import type { CollectContext } from "../src/types.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nx-conv-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A CollectContext rooted at `cwd` with the char/4 estimator. */
function ctx(cwd: string, userMessage = "hello"): CollectContext {
  return { userMessage, cwd, now: 0, estimate: (t: string) => Math.ceil(t.length / 4) };
}

describe("ProjectConventionsSource", () => {
  it("reads CLAUDE.md and AGENTS.md into the static `conventions` lane", async () => {
    writeFileSync(join(root, "CLAUDE.md"), "Always write tests first.");
    writeFileSync(join(root, "AGENTS.md"), "Prefer small commits.");

    const src = new ProjectConventionsSource({ home: root, includeGlobal: false });
    expect(src.kind).toBe("static");

    const chunks = await src.collect(ctx(root));
    expect(chunks).toHaveLength(2);
    expect(chunks.every((c) => c.lane === "conventions")).toBe(true);
    expect(chunks.every((c) => c.sourceId === "project-conventions")).toBe(true);

    const text = chunks.map((c) => c.text).join("\n");
    expect(text).toContain("Always write tests first.");
    expect(text).toContain("Prefer small commits.");
  });

  it("contributes nothing when the project has no instruction files", async () => {
    const src = new ProjectConventionsSource({ home: root, includeGlobal: false });
    expect(await src.collect(ctx(root))).toEqual([]);
  });

  it("skips an empty/whitespace-only instruction file", async () => {
    writeFileSync(join(root, "CLAUDE.md"), "   \n\n  ");
    const src = new ProjectConventionsSource({ home: root, includeGlobal: false });
    expect(await src.collect(ctx(root))).toEqual([]);
  });

  it("ranks nearer (project) files above farther/global ones", async () => {
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "CLAUDE.md"), "outer rule");
    writeFileSync(join(nested, "CLAUDE.md"), "inner rule");

    const src = new ProjectConventionsSource({ home: root, includeGlobal: false });
    const chunks = await src.collect(ctx(nested));

    // Nearest first, and strictly higher relevance so it survives trimming longer.
    expect(chunks[0]!.text).toContain("inner rule");
    expect(chunks[1]!.text).toContain("outer rule");
    expect(chunks[0]!.relevance!).toBeGreaterThan(chunks[1]!.relevance!);
  });

  it("truncates a file past the per-file byte cap instead of blowing the budget", async () => {
    writeFileSync(join(root, "CLAUDE.md"), "x".repeat(50_000));
    const src = new ProjectConventionsSource({
      home: root,
      includeGlobal: false,
      maxBytesPerFile: 100,
    });
    const chunks = await src.collect(ctx(root));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("… (truncated)");
    // Header + 100 bytes + marker — bounded well under the raw 50k.
    expect(chunks[0]!.text.length).toBeLessThan(500);
  });

  it("caps how many instruction files are emitted, nearest first", async () => {
    const deep = join(root, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    for (const dir of [root, join(root, "a"), join(root, "a", "b"), deep]) {
      writeFileSync(join(dir, "CLAUDE.md"), `rule at ${dir}`);
    }
    const src = new ProjectConventionsSource({ home: root, includeGlobal: false, maxFiles: 2 });
    const chunks = await src.collect(ctx(deep));
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toContain(deep);
  });

  it("is deterministic across runs, so the cacheable prefix stays byte-stable", async () => {
    writeFileSync(join(root, "CLAUDE.md"), "stable rule");
    writeFileSync(join(root, "AGENTS.md"), "another rule");
    const src = new ProjectConventionsSource({ home: root, includeGlobal: false });

    const a = await src.collect(ctx(root, "first question"));
    const b = await src.collect(ctx(root, "a totally different question"));
    // Query-independent by construction: identical ids AND identical text.
    expect(b.map((c) => c.id)).toEqual(a.map((c) => c.id));
    expect(b.map((c) => c.text)).toEqual(a.map((c) => c.text));
  });

  it("lands in the assembled system prefix, not the volatile messages", async () => {
    writeFileSync(join(root, "CLAUDE.md"), "Never push to main.");
    const engine = new ContextEngine();
    const res = await engine.assemble({
      budgetTokens: 2000,
      sources: [new ProjectConventionsSource({ home: root, includeGlobal: false })],
      userMessage: "what should I do?",
      cwd: root,
      now: 0,
    });

    expect(res.system).toContain("Never push to main.");
    expect(JSON.stringify(res.messages)).not.toContain("Never push to main.");
    expect(res.report.staticTokens).toBeGreaterThan(0);
    const lane = res.report.lanes.find((l) => l.lane === "conventions");
    expect(lane?.kind).toBe("static");
    expect(lane?.tokens).toBeGreaterThan(0);
  });

  it("degrades gracefully: an unreadable path yields no chunk rather than throwing", async () => {
    // A directory named CLAUDE.md — readFile rejects with EISDIR.
    mkdirSync(join(root, "CLAUDE.md"));
    writeFileSync(join(root, "AGENTS.md"), "still readable");
    const src = new ProjectConventionsSource({ home: root, includeGlobal: false });
    const chunks = await src.collect(ctx(root));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toContain("still readable");
  });
});
