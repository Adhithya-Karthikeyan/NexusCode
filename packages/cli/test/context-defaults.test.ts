/**
 * Default-config context regression (the "harness, not chatbot" contract).
 *
 * Out of the box NexusCode used to send the system prompt and the user's bare
 * message: `fileintel.repoMap` and `rag.enabled` both defaulted false, so
 * `buildPowerSources` contributed a MemorySource and nothing else — no repo
 * structure, no project conventions. These tests pin the new defaults, prove the
 * project context reaches the assembled request the provider receives, and prove
 * it stays inside the token budget on a large tree.
 *
 * Everything here is offline and deterministic: temp fixture repo, temp data dir,
 * no network, no real provider call.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NexusConfig as NexusConfigSchema } from "@nexuscode/config";
import { ContextEngine } from "@nexuscode/context";
import type { Message } from "@nexuscode/shared";

import { buildPowerSources } from "../src/power.js";
import { EngineContextAssembler } from "../src/commands.js";

let root: string;
let prevData: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nx-ctxdef-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  prevData = process.env["NEXUS_DATA_DIR"];
  process.env["NEXUS_DATA_DIR"] = dataDir;

  // A small fixture project: conventions file + a couple of source files so the
  // repo map has something structural to rank.
  writeFileSync(
    join(root, "CLAUDE.md"),
    "# Project rules\nAlways run `npm test` before claiming done.\n",
  );
  writeFileSync(
    join(root, "router.ts"),
    [
      "export function selectProvider(rule: string): string {",
      "  return chooseCandidate(rule);",
      "}",
      "export function chooseCandidate(rule: string): string {",
      "  return rule;",
      "}",
    ].join("\n"),
  );
  writeFileSync(join(root, "cache.ts"), "export function cacheKey(s: string): string {\n  return s;\n}\n");
});

afterEach(() => {
  if (prevData === undefined) delete process.env["NEXUS_DATA_DIR"];
  else process.env["NEXUS_DATA_DIR"] = prevData;
  rmSync(root, { recursive: true, force: true });
});

/** Concatenated text of a message list — what the provider would actually read. */
function messageText(messages: Message[]): string {
  return messages
    .map((m) => m.content.map((c) => ("text" in c ? c.text : "")).join(""))
    .join("\n");
}

describe("default config assembles real project context", () => {
  it("buildPowerSources contributes structure + conventions out of the box", () => {
    const config = NexusConfigSchema.parse({});
    const ids = buildPowerSources(config, { cwd: root }).map((s) => s.id);

    // The regression this file exists for: these three were absent by default.
    expect(ids).toContain("project-conventions");
    expect(ids).toContain("repo-map");
    expect(ids).toContain("git-diff");
    expect(ids).toContain("memory");
  });

  it("keeps RAG retrieval OFF by default (the index is global, not per-project)", () => {
    const config = NexusConfigSchema.parse({});
    // The persisted index lives in a GLOBAL data dir, so "an index exists" does
    // not mean "this project's index exists". Defaulting on would retrieve
    // another repo's code into this repo's prompt — and parse an 81MB file to
    // do it. Off until the index is project-scoped.
    expect(config.rag.enabled).toBe(false);
    expect(buildPowerSources(config, { cwd: root }).map((s) => s.id)).not.toContain("rag");
  });

  it("still contributes nothing when RAG is enabled but no index exists", () => {
    const config = NexusConfigSchema.parse({ rag: { enabled: true } });
    // Permission, not a promise: no persisted index in this temp data dir ⇒ the
    // source must not join rather than spend a query for zero chunks.
    const ids = buildPowerSources(config, { cwd: root }).map((s) => s.id);
    expect(ids).not.toContain("rag");
  });

  it("the conventions file and repo map reach the assembled system prefix", async () => {
    const config = NexusConfigSchema.parse({});
    const engine = new ContextEngine();
    const res = await engine.assemble({
      budgetTokens: 4000,
      sources: buildPowerSources(config, { cwd: root }),
      userMessage: "how does provider selection work?",
      cwd: root,
      now: 0,
    });

    // Project conventions are actually sent.
    expect(res.system).toContain("Always run `npm test` before claiming done.");
    // Structural context is actually sent.
    expect(res.system).toContain("router.ts");

    // Both land in the CACHE-STABLE static prefix, so a session pays once.
    expect(res.report.staticTokens).toBeGreaterThan(0);
    const lanes = new Map(res.report.lanes.map((l) => [l.lane, l]));
    expect(lanes.get("conventions")?.kind).toBe("static");
    expect(lanes.get("repo-map")?.kind).toBe("static");
  });

  it("end-to-end: EngineContextAssembler puts project context in the outgoing request", async () => {
    const config = NexusConfigSchema.parse({});
    const assembler = new EngineContextAssembler(
      new ContextEngine(),
      buildPowerSources(config, { cwd: root }),
      4000,
    );

    const out = await assembler.assemble(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "what does the router do?" }] }],
        system: "You are NexusCode.",
      },
      new AbortController().signal,
    );

    // The caller's system prompt survives AND carries the project context.
    expect(out.system).toContain("You are NexusCode.");
    expect(out.system).toContain("Always run `npm test` before claiming done.");
    expect(out.system).toContain("router.ts");

    // The user's real turn is preserved exactly once — the conventions/repo map
    // ride the system prefix, they do not get duplicated into the transcript.
    expect(out.messages.map((m) => m.role)).toEqual(["user"]);
    expect(messageText(out.messages)).toContain("what does the router do?");
    expect(messageText(out.messages)).not.toContain("Always run `npm test`");
  });
});

describe("default context stays inside its budget", () => {
  it("a large repo is packed within the budget rather than blowing up the request", async () => {
    // 400 files with real content — far more than any budget could hold.
    const big = join(root, "src");
    mkdirSync(big, { recursive: true });
    for (let i = 0; i < 400; i++) {
      writeFileSync(
        join(big, `mod${i}.ts`),
        `export function fn${i}(x: string): string {\n  return helper${i}(x);\n}\n` +
          `export function helper${i}(x: string): string {\n  return x.repeat(${i % 7});\n}\n`,
      );
    }
    // An oversized conventions file too.
    writeFileSync(join(root, "AGENTS.md"), `# Rules\n${"blah blah rule. ".repeat(5000)}`);

    const config = NexusConfigSchema.parse({});
    const budgetTokens = 4000;
    const res = await new ContextEngine().assemble({
      budgetTokens,
      sources: buildPowerSources(config, { cwd: root }),
      userMessage: "explain the module layout",
      cwd: root,
      now: 0,
    });

    expect(res.report.realTokens).toBeLessThanOrEqual(budgetTokens);
    expect(res.report.overBudget).toBe(false);

    // Defence in depth: each source is ALSO bounded before the engine packs, so
    // the amount collected does not scale with repo size. 400 files plus a ~75KB
    // instruction file must still collect a few thousand tokens, not a few
    // hundred thousand — this is what keeps cost proportionate on a huge repo.
    expect(res.report.nominalTokens).toBeLessThan(3 * budgetTokens);

    // The repo map honours its own `fileintel.budgetTokens` cap (default 1024).
    const repoMapLane = res.report.lanes.find((l) => l.lane === "repo-map");
    expect(repoMapLane!.tokens).toBeLessThanOrEqual(config.fileintel.budgetTokens + 64);
  });

  it("caps what the DEFAULT context adds to a request, even with huge inputs", async () => {
    // Cost regression guard. Prompt caching is not wired on the provider path,
    // so whatever this adds is re-paid on EVERY turn of an agent loop — an
    // 8-turn run multiplies it by 8. Keep the per-request figure small.
    const deep = join(root, "a", "b");
    mkdirSync(deep, { recursive: true });
    // Oversized instruction files at several scopes…
    for (const dir of [root, join(root, "a"), deep]) {
      writeFileSync(join(dir, "CLAUDE.md"), `# Rules\n${"rule text. ".repeat(20_000)}`);
      writeFileSync(join(dir, "AGENTS.md"), `# More\n${"agent text. ".repeat(20_000)}`);
    }
    // …and plenty of files for the map.
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(deep, `m${i}.ts`), `export const v${i} = ${i};\n`);
    }

    const config = NexusConfigSchema.parse({});
    const res = await new ContextEngine().assemble({
      budgetTokens: 4000,
      sources: buildPowerSources(config, { cwd: deep }),
      userMessage: "hi",
      cwd: deep,
      now: 0,
    });

    // Static lanes are what actually reach the model today (volatile is dropped
    // by the assembler). This is the number that shows up on every request.
    const staticCost = res.report.staticTokens;
    expect(staticCost).toBeLessThan(3000);
    // The repo map honours its own budget…
    const repoMap = res.report.lanes.find((l) => l.lane === "repo-map");
    expect(repoMap!.tokens).toBeLessThanOrEqual(config.fileintel.budgetTokens + 64);
    // …and conventions cannot run away, however large the instruction files are.
    const conv = res.report.lanes.find((l) => l.lane === "conventions");
    expect(conv!.tokens).toBeLessThan(2600);
    // Absolute ceiling: nothing the engine assembles exceeds the budget.
    expect(res.report.realTokens).toBeLessThanOrEqual(4000);
  });

  it("respects a small budget without dropping the user's message", async () => {
    const config = NexusConfigSchema.parse({});
    const res = await new ContextEngine().assemble({
      budgetTokens: 200,
      sources: buildPowerSources(config, { cwd: root }),
      userMessage: "hi",
      cwd: root,
      now: 0,
    });
    expect(res.report.realTokens).toBeLessThanOrEqual(200);
    expect(messageText(res.messages)).toContain("hi");
  });
});

describe("every default context source is overridable", () => {
  it("config can turn the new context off entirely", () => {
    const config = NexusConfigSchema.parse({
      fileintel: { repoMap: false },
      rag: { enabled: false },
      context: { conventions: false, git: false },
    });
    const ids = buildPowerSources(config, { cwd: root }).map((s) => s.id);
    expect(ids).toEqual(["memory"]);
  });

  it("env vars stay opt-in and are masked when secret-looking", async () => {
    const off = NexusConfigSchema.parse({});
    expect(buildPowerSources(off, { cwd: root }).map((s) => s.id)).not.toContain("env");

    const on = NexusConfigSchema.parse({ context: { envKeys: ["NX_TEST_TOKEN", "NX_TEST_PLAIN"] } });
    process.env["NX_TEST_TOKEN"] = "super-secret";
    process.env["NX_TEST_PLAIN"] = "plain-value";
    try {
      const src = buildPowerSources(on, { cwd: root }).find((s) => s.id === "env");
      expect(src).toBeDefined();
      const chunks = await src!.collect({
        userMessage: "q",
        cwd: root,
        now: 0,
        estimate: (t: string) => Math.ceil(t.length / 4),
      });
      const text = chunks.map((c) => c.text).join("\n");
      expect(text).toContain("NX_TEST_PLAIN=plain-value");
      expect(text).not.toContain("super-secret");
    } finally {
      delete process.env["NX_TEST_TOKEN"];
      delete process.env["NX_TEST_PLAIN"];
    }
  });

  it("a source that finds nothing contributes nothing instead of failing the turn", async () => {
    // A dir with no instruction files ANYWHERE above it and no git repo. It must
    // live outside `root` — the conventions walk deliberately climbs to the
    // filesystem root, so a subdir of `root` would inherit its CLAUDE.md.
    const bare = mkdtempSync(join(tmpdir(), "nx-bare-"));
    const config = NexusConfigSchema.parse({
      // Neutralise any real CLAUDE.md/AGENTS.md above the OS temp dir so this
      // asserts the empty-source path rather than the host machine's layout.
      context: { conventions: false },
    });
    const res = await new ContextEngine().assemble({
      budgetTokens: 4000,
      sources: buildPowerSources(config, { cwd: bare }),
      userMessage: "hello",
      cwd: bare,
      now: 0,
    });
    const lanes = new Map(res.report.lanes.map((l) => [l.lane, l.tokens]));
    expect(lanes.get("conventions") ?? 0).toBe(0);
    // Not a git repo ⇒ the git lane is empty rather than an error.
    expect(lanes.get("git") ?? 0).toBe(0);
    // The turn still completes and the user's message is intact.
    expect(res.report.overBudget).toBe(false);
    expect(messageText(res.messages)).toContain("hello");
    rmSync(bare, { recursive: true, force: true });
  });
});
