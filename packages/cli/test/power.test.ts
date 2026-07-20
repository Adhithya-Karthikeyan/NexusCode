/**
 * Wave-5 context-power wiring — offline, deterministic unit tests. Exercises the
 * factories in `src/power.ts` directly (no spawned binary): the RagSource +
 * RepoMapSource contributing to an assembled ContextReport with citations, the
 * embedding cache, and the response cache's savings accounting.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NexusConfig as NexusConfigSchema } from "@nexuscode/config";
import { ContextEngine } from "@nexuscode/context";
import { HashingEmbedder, RagRetrievalSource } from "@nexuscode/rag";
import { userText, type ChatRequest } from "@nexuscode/core";

import {
  CachingEmbedder,
  anthropicPrefixBlocks,
  buildPowerSources,
  collectIndexableDocs,
  makeEmbeddingCache,
  openRagIndex,
  openResponseCache,
  preferAffineProvider,
  sessionAffinity,
} from "../src/power.js";

let root: string;
let dataDir: string;
let prevData: string | undefined;

/** A NexusConfig with the context-power layer turned on, rooted at temp dirs. */
function powerConfig(overrides: Record<string, unknown> = {}) {
  return NexusConfigSchema.parse({
    rag: { enabled: true, dims: 128, storeFile: join(root, "rag-index.json") },
    fileintel: { repoMap: true, budgetTokens: 512 },
    cache: { enabled: true, backend: "memory", dir: join(root, "cache") },
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nx-power-"));
  dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  prevData = process.env["NEXUS_DATA_DIR"];
  process.env["NEXUS_DATA_DIR"] = dataDir;

  // A tiny, cross-referencing fixture project so the repo map has ranked symbols
  // and RAG has distinctive text to retrieve.
  writeFileSync(
    join(root, "router.ts"),
    [
      "// The router selects a provider candidate for a request.",
      "export function selectProvider(rule: string): string {",
      "  return chooseCandidate(rule);",
      "}",
      "export function chooseCandidate(rule: string): string {",
      "  return rule.includes('cheap') ? 'ollama' : 'anthropic';",
      "}",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "cache.ts"),
    [
      "// The response cache short-circuits identical requests to save tokens.",
      "import { selectProvider } from './router.js';",
      "export function cachedSelect(rule: string): string {",
      "  return selectProvider(rule);",
      "}",
    ].join("\n"),
    "utf8",
  );
});

afterEach(() => {
  if (prevData === undefined) delete process.env["NEXUS_DATA_DIR"];
  else process.env["NEXUS_DATA_DIR"] = prevData;
  rmSync(root, { recursive: true, force: true });
});

describe("buildPowerSources → assembled ContextReport", () => {
  it("RagSource + RepoMapSource both contribute (report shows them) with citations", async () => {
    const config = powerConfig();

    // Build + persist the RAG index over the fixture (what `nexus index` does).
    const index = openRagIndex(config, { cached: false, load: false });
    const docs = await collectIndexableDocs(root, config);
    expect(docs.length).toBeGreaterThan(0);
    await index.index(docs.map((d) => ({ id: d.id, text: d.text, source: d.path })));
    index.save();

    const sources = buildPowerSources(config, { cwd: root });
    const ids = sources.map((s) => s.id);
    expect(ids).toContain("repo-map");
    expect(ids).toContain("rag");

    const engine = new ContextEngine();
    const res = await engine.assemble({
      budgetTokens: 8000,
      sources,
      userMessage: "how does the response cache save tokens",
      cwd: root,
      now: 0,
    });

    const byId = new Map(res.report.sources.map((s) => [s.id, s]));
    const repoMapReport = byId.get("repo-map");
    const ragReport = byId.get("rag");
    expect(repoMapReport?.included).toBeGreaterThan(0);
    expect(ragReport?.included).toBeGreaterThan(0);

    // The repo map lands in the cache-stable static prefix; retrieved chunks in
    // the query-dependent (still pre-history) region.
    expect(res.report.staticTokens).toBeGreaterThan(0);
    const retrievedLane = res.report.lanes.find((l) => l.lane === "retrieved");
    expect(retrievedLane?.tokens).toBeGreaterThan(0);

    // Citations: the RAG source stamps docId + span + source onto every chunk.
    const ragSource = sources.find((s) => s.id === "rag")!;
    const chunks = await ragSource.collect({
      userMessage: "response cache tokens",
      cwd: root,
      now: 0,
      estimate: (t) => Math.ceil(t.length / 4),
    });
    expect(chunks.length).toBeGreaterThan(0);
    const meta = chunks[0]!.meta as { docId?: string; span?: { start: number; end: number }; source?: string };
    expect(typeof meta.docId).toBe("string");
    expect(typeof meta.span?.start).toBe("number");
    expect(meta.source).toBeTruthy();
  });
});

describe("collectIndexableDocs — aggregate budgets (never silently truncate)", () => {
  it("stops at rag.maxTotalBytes and logs an honest truncation notice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-power-budget-bytes-"));
    try {
      // 5 files of exactly 200 bytes each; a 450-byte budget lets in only 2.
      for (let i = 0; i < 5; i++) {
        writeFileSync(join(dir, `f${i}.ts`), "a".repeat(200), "utf8");
      }
      const config = NexusConfigSchema.parse({ rag: { maxTotalBytes: 450 } });
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const docs = await collectIndexableDocs(dir, config);
        expect(docs.length).toBe(2); // 200 + 200 fits under 450; the 3rd would push to 600
        expect(spy).toHaveBeenCalled();
        const logged = spy.mock.calls.map((c) => String(c[0])).join("");
        expect(logged).toContain("reached limit");
        expect(logged).toContain("indexed a subset");
        expect(logged).toContain("rag.maxTotalBytes");
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops at rag.maxTotalChunks (estimated from chunkSize/overlap) and logs a truncation notice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-power-budget-chunks-"));
    try {
      // chunkStep = chunkSize - overlap = 100 chars/chunk.
      // "a-short" (250 chars) -> ceil(250/100) = 3 estimated chunks.
      // "b-long"  (950 chars) -> ceil(950/100) = 10 estimated chunks.
      // A budget of 5 lets "a-short" in but stops before "b-long".
      writeFileSync(join(dir, "a-short.ts"), "x".repeat(250), "utf8");
      writeFileSync(join(dir, "b-long.ts"), "y".repeat(950), "utf8");
      const config = NexusConfigSchema.parse({ rag: { chunkSize: 100, overlap: 0, maxTotalChunks: 5 } });
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const docs = await collectIndexableDocs(dir, config);
        expect(docs.map((d) => d.path)).toEqual(["a-short.ts"]);
        expect(spy).toHaveBeenCalled();
        const logged = spy.mock.calls.map((c) => String(c[0])).join("");
        expect(logged).toContain("reached limit");
        expect(logged).toContain("rag.maxTotalChunks");
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not log a truncation notice when nothing was truncated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nx-power-no-budget-"));
    try {
      writeFileSync(join(dir, "small.ts"), "export const x = 1;\n", "utf8");
      const config = NexusConfigSchema.parse({});
      const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const docs = await collectIndexableDocs(dir, config);
        expect(docs.length).toBe(1);
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CachingEmbedder", () => {
  it("memoizes vectors: identical input on the second pass is all hits, savings booked", async () => {
    const config = powerConfig();
    const cache = makeEmbeddingCache(config);
    const emb = new CachingEmbedder(new HashingEmbedder({ dims: 64 }), cache);

    const texts = ["hello world", "provider routing"];
    const first = await emb.embed(texts);
    const second = await emb.embed(texts);
    expect(second).toEqual(first);

    const stats = await emb.stats();
    expect(stats.hits).toBe(texts.length); // the whole second pass hit the cache
    expect(stats.savedTokens).toBeGreaterThan(0);
  });
});

describe("openResponseCache — savings accounting", () => {
  it("miss → set → hit books the avoided input+output tokens as savings", async () => {
    const config = powerConfig();
    const cache = openResponseCache(config)!;
    expect(cache).toBeDefined();

    const req: ChatRequest = { model: "mock-fast", messages: userText("hi cache") };
    expect(await cache.get(req)).toBeUndefined(); // miss

    await cache.set(req, {
      text: "Echo: hi cache",
      usage: { inputTokens: 100, outputTokens: 50 },
      model: "mock-fast",
    });

    const hit = await cache.get(req);
    expect(hit?.text).toBe("Echo: hi cache");

    const stats = await cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.savedTokens).toBe(150);
  });

  it("returns undefined when the cache is disabled", () => {
    const config = powerConfig({ cache: { enabled: false } });
    expect(openResponseCache(config)).toBeUndefined();
  });
});

describe("preferAffineProvider — router cache-affinity hook", () => {
  const candidates = [
    { providerId: "anthropic", modelId: "claude" },
    { providerId: "ollama", modelId: "llama" },
    { providerId: "openai", modelId: "gpt" },
  ];

  it("reorders the pinned provider first while preserving the rest, and never drops a candidate", () => {
    const config = powerConfig();
    const key = "affinity-test-a";
    sessionAffinity().recordUse(key, "ollama");
    const out = preferAffineProvider(config, key, candidates);
    expect(out.map((c) => c.providerId)).toEqual(["ollama", "anthropic", "openai"]);
    // Failover safety: every original candidate is still present (only reordered).
    expect(out).toHaveLength(candidates.length);
    sessionAffinity().clear(key);
  });

  it("is a no-op when affinity is disabled or the pin is absent", () => {
    const key = "affinity-test-b";
    const disabled = preferAffineProvider(powerConfig({ cache: { affinity: false } }), key, candidates);
    expect(disabled.map((c) => c.providerId)).toEqual(["anthropic", "ollama", "openai"]);
    const noPin = preferAffineProvider(powerConfig(), "never-pinned-key", candidates);
    expect(noPin.map((c) => c.providerId)).toEqual(["anthropic", "ollama", "openai"]);
  });
});

describe("anthropicPrefixBlocks — prompt prefix cache_control injection", () => {
  it("marks the trailing static block with an ephemeral cache_control breakpoint", () => {
    const blocks = anthropicPrefixBlocks("# System\nyou are helpful", [12]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toContain("you are helpful");
    expect(blocks[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  it("produces no blocks for an empty prefix", () => {
    expect(anthropicPrefixBlocks("")).toHaveLength(0);
  });
});
