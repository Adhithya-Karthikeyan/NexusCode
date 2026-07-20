/**
 * @nexuscode/rag tests — all offline & deterministic (HashingEmbedder only, no
 * network). Covers: embedder determinism, chunking + spans, vector store cosine
 * search + delete + JSON persistence, the Index API (index→query returns the
 * semantically-closest chunk), hybrid > pure-keyword on a synonym case, metadata
 * filtering, citations, and the Context Engine bridge source.
 */

import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  Bm25Index,
  HashingEmbedder,
  InMemoryVectorStore,
  RagIndex,
  RagRetrievalSource,
  SECRET_PLACEHOLDER,
  chunkDocument,
  chunkText,
  containsSecret,
  createHashingEmbedder,
  redactSecrets,
  type Embedder,
  type RagDocument,
} from "../src/index.js";

import { readFileSync } from "node:fs";

// A tiny estimator for the CollectContext seam (char/4).
const estimate = (t: string) => Math.ceil(t.length / 4);

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "nexus-rag-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

// ── Embedder ────────────────────────────────────────────────────────────────

describe("HashingEmbedder", () => {
  it("is deterministic across calls and instances, with correct dims + L2 norm", async () => {
    const a = new HashingEmbedder({ dims: 128 });
    const b = new HashingEmbedder({ dims: 128 });
    const [v1] = await a.embed(["the quick brown fox"]);
    const [v2] = await a.embed(["the quick brown fox"]);
    const [v3] = await b.embed(["the quick brown fox"]);

    expect(v1).toHaveLength(128);
    expect(v1).toEqual(v2); // stable across calls
    expect(v1).toEqual(v3); // stable across instances

    const normSq = v1!.reduce((s, x) => s + x * x, 0);
    expect(Math.sqrt(normSq)).toBeCloseTo(1, 6); // L2-normalized
  });

  it("gives similar texts higher cosine than dissimilar ones", async () => {
    const e = new HashingEmbedder({ dims: 256 });
    const [q, near, far] = await e.embed([
      "reading and writing files on disk",
      "how to write a file to disk",
      "the orbital mechanics of distant planets",
    ]);
    const cos = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(cos(q!, near!)).toBeGreaterThan(cos(q!, far!));
  });

  it("empty text yields a zero vector", async () => {
    const e = new HashingEmbedder({ dims: 32 });
    const [v] = await e.embed([""]);
    expect(v!.every((x) => x === 0)).toBe(true);
  });
});

// ── Chunker ─────────────────────────────────────────────────────────────────

describe("chunker", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("hello world", { chunkSize: 100 })).toEqual([{ start: 0, end: 11 }]);
  });

  it("splits long text into overlapping, gap-free, reconstructable spans", () => {
    const text = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const spans = chunkText(text, { chunkSize: 60, overlap: 15 });
    expect(spans.length).toBeGreaterThan(1);

    for (const s of spans) {
      expect(s.end).toBeGreaterThan(s.start);
      expect(s.end - s.start).toBeLessThanOrEqual(60);
    }
    // Consecutive chunks overlap (each starts before the previous ended).
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start).toBeLessThan(spans[i - 1]!.end);
    }
    // Full coverage: the union of spans reaches the end of the text.
    expect(spans[spans.length - 1]!.end).toBe(text.length);
  });

  it("chunkDocument stamps citeable spans + propagates provenance", () => {
    const doc: RagDocument = {
      id: "d1",
      text: "alpha beta gamma delta epsilon zeta eta theta iota kappa",
      source: "notes.md",
      lang: "md",
      meta: { topic: "greek" },
    };
    const chunks = chunkDocument(doc, { chunkSize: 20, overlap: 5 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.docId).toBe("d1");
      expect(c.source).toBe("notes.md");
      expect(c.lang).toBe("md");
      expect(c.meta).toEqual({ topic: "greek" });
      // The span exactly reconstructs the chunk text.
      expect(doc.text.slice(c.span.start, c.span.end)).toBe(c.text);
    }
    expect(chunks[0]!.id).toBe("d1#0");
  });
});

// ── VectorStore ───────────────────────────────────────────────────────────────

describe("InMemoryVectorStore", () => {
  const mkChunk = (id: string) => ({
    id,
    docId: id,
    index: 0,
    text: id,
    span: { start: 0, end: id.length },
  });

  it("cosine search ranks the nearest vector first; delete removes it", () => {
    const store = new InMemoryVectorStore(3);
    store.add([
      { id: "x", vector: [1, 0, 0], chunk: mkChunk("x") },
      { id: "y", vector: [0, 1, 0], chunk: mkChunk("y") },
      { id: "z", vector: [0.9, 0.1, 0], chunk: mkChunk("z") },
    ]);
    const hits = store.search([1, 0, 0], 2);
    expect(hits[0]!.id).toBe("x");
    expect(hits[1]!.id).toBe("z"); // closer than y
    expect(hits[0]!.score).toBeCloseTo(1, 6);

    expect(store.delete(["x"])).toBe(1);
    expect(store.size).toBe(2);
    expect(store.search([1, 0, 0], 1)[0]!.id).toBe("z");
  });

  it("rejects dimension mismatches", () => {
    const store = new InMemoryVectorStore(3);
    expect(() => store.add([{ id: "bad", vector: [1, 0], chunk: mkChunk("bad") }])).toThrow(
      /dim mismatch/,
    );
  });

  it("round-trips through JSON persistence in a temp dir", () => {
    const dir = freshDir();
    const file = join(dir, "vs.json");
    const store = new InMemoryVectorStore(3, { embedderId: "hashing-3" });
    store.add([
      { id: "a", vector: [1, 0, 0], chunk: mkChunk("a") },
      { id: "b", vector: [0, 1, 0], chunk: mkChunk("b") },
    ]);
    const saved = store.save(file);
    expect(saved).toBe(file);
    expect(existsSync(file)).toBe(true);

    const restored = new InMemoryVectorStore(3);
    restored.load(file);
    expect(restored.size).toBe(2);
    expect(restored.search([1, 0, 0], 1)[0]!.id).toBe("a");
    expect(restored.chunks().map((c) => c.id).sort()).toEqual(["a", "b"]);
  });
});

// ── BM25 ────────────────────────────────────────────────────────────────────

describe("Bm25Index", () => {
  it("scores lexical overlap and returns nothing for a miss", () => {
    const bm = new Bm25Index();
    bm.rebuild([
      { id: "1", docId: "1", index: 0, text: "the cat sat on the mat", span: { start: 0, end: 0 } },
      { id: "2", docId: "2", index: 0, text: "a dog ran in the park", span: { start: 0, end: 0 } },
    ]);
    const scores = bm.scoreAll("cat");
    expect(scores.get("1")).toBeGreaterThan(0);
    expect(scores.has("2")).toBe(false);
    expect(bm.scoreAll("zebra").size).toBe(0);
  });
});

// ── Index API: semantic retrieval ─────────────────────────────────────────────

describe("RagIndex.query — semantic retrieval", () => {
  const docs: RagDocument[] = [
    { id: "files", text: "Reading and writing files to disk with streams and buffers in Node.", source: "files.md" },
    { id: "baking", text: "A recipe for baking sourdough bread with flour, water, and yeast.", source: "baking.md" },
    { id: "space", text: "The orbital mechanics of planets around distant stars in the galaxy.", source: "space.md" },
  ];

  it("returns the semantically-closest chunk at rank 1", async () => {
    const index = new RagIndex({ embedder: createHashingEmbedder({ dims: 512 }) });
    await index.index(docs);
    const results = await index.query("how do I write a file to the disk?", { topK: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.chunk.docId).toBe("files");
  });

  it("results carry citations (source + reconstructable span)", async () => {
    const index = new RagIndex({ embedder: createHashingEmbedder({ dims: 512 }) });
    await index.index(docs);
    const [top] = await index.query("baking bread recipe with yeast", { topK: 1 });
    expect(top!.chunk.docId).toBe("baking");
    expect(top!.citation.source).toBe("baking.md");
    expect(top!.citation.span.end).toBeGreaterThan(top!.citation.span.start);
    const original = docs.find((d) => d.id === "baking")!;
    expect(original.text.slice(top!.citation.span.start, top!.citation.span.end)).toBe(
      top!.chunk.text,
    );
  });
});

// ── Index API: hybrid beats pure keyword on synonyms ──────────────────────────

describe("RagIndex.query — hybrid vs pure keyword (synonym recall gap)", () => {
  // Query uses synonyms of the relevant doc's words; the lexicon lets the offline
  // embedder place them close. Pure keyword has no lexical overlap → it cannot
  // retrieve the relevant doc at all; hybrid (which includes the semantic signal)
  // surfaces it at rank 1. This is the textbook reason hybrid > keyword.
  const lexicon = { vehicle: "car", issue: "problem", repair: "fix" };
  const docs: RagDocument[] = [
    { id: "auto", text: "My car has a problem and needs a fix from the mechanic.", source: "auto.md" },
    { id: "cooking", text: "Boil the pasta then add the tomato sauce and basil.", source: "cook.md" },
    { id: "astro", text: "The telescope captured a nebula in the night sky.", source: "astro.md" },
  ];

  async function build() {
    const index = new RagIndex({ embedder: createHashingEmbedder({ dims: 512, lexicon }) });
    await index.index(docs);
    return index;
  }

  it("pure keyword misses the synonym doc; semantic + hybrid find it", async () => {
    const index = await build();
    const q = "vehicle repair issue"; // synonyms of car / fix / problem

    const keyword = await index.query(q, { mode: "keyword", topK: 3 });
    expect(keyword.some((r) => r.chunk.docId === "auto")).toBe(false); // recall gap

    const semantic = await index.query(q, { mode: "semantic", topK: 3 });
    expect(semantic[0]!.chunk.docId).toBe("auto");

    const hybrid = await index.query(q, { mode: "hybrid", topK: 3 });
    expect(hybrid[0]!.chunk.docId).toBe("auto"); // hybrid beats pure keyword
  });
});

// ── Index API: metadata filtering ─────────────────────────────────────────────

describe("RagIndex.query — metadata filter", () => {
  const docs: RagDocument[] = [
    { id: "ts-io", text: "read file write file open close stream buffer", source: "a.ts", lang: "ts", meta: { area: "io" } },
    { id: "py-io", text: "read file write file open close stream buffer", source: "b.py", lang: "py", meta: { area: "io" } },
    { id: "ts-net", text: "socket connect listen accept packet", source: "c.ts", lang: "ts", meta: { area: "net" } },
  ];

  it("restricts results to chunks matching the filter", async () => {
    const index = new RagIndex({ embedder: createHashingEmbedder({ dims: 512 }) });
    await index.index(docs);

    const byLang = await index.query("read and write a file", { filter: { lang: "py" }, topK: 5 });
    expect(byLang.length).toBeGreaterThan(0);
    expect(byLang.every((r) => r.chunk.lang === "py")).toBe(true);

    const byMeta = await index.query("read and write a file", {
      filter: { meta: { area: "io" }, lang: "ts" },
      topK: 5,
    });
    expect(byMeta.every((r) => r.chunk.lang === "ts" && r.chunk.meta?.area === "io")).toBe(true);
    expect(byMeta[0]!.chunk.docId).toBe("ts-io");

    const byPredicate = await index.query("socket packet", {
      filter: { predicate: (c) => c.docId.startsWith("ts-") },
      topK: 5,
    });
    expect(byPredicate.every((r) => r.chunk.docId.startsWith("ts-"))).toBe(true);
  });
});

// ── Index API: persistence round-trip ─────────────────────────────────────────

describe("RagIndex — persistence", () => {
  it("save then load into a fresh index preserves query behavior", async () => {
    const dir = freshDir();
    const file = join(dir, "rag-index.json");
    const docs: RagDocument[] = [
      { id: "files", text: "writing files to disk with streams in node", source: "f.md" },
      { id: "cake", text: "a chocolate cake recipe with sugar and eggs", source: "c.md" },
    ];

    const index = new RagIndex({ embedder: createHashingEmbedder({ dims: 512 }), file });
    await index.index(docs);
    const before = await index.query("write a file to disk", { topK: 1 });
    index.save();
    expect(existsSync(file)).toBe(true);

    // Fresh index + store, no in-memory carryover.
    const store = new InMemoryVectorStore(512);
    const reloaded = new RagIndex({ embedder: createHashingEmbedder({ dims: 512 }), store, file });
    reloaded.load();
    expect(reloaded.size).toBe(index.size);
    const after = await reloaded.query("write a file to disk", { topK: 1 });
    expect(after[0]!.chunk.id).toBe(before[0]!.chunk.id);
    expect(after[0]!.chunk.docId).toBe("files");
  });

  it("re-indexing a document replaces its old chunks", async () => {
    const index = new RagIndex({ embedder: createHashingEmbedder({ dims: 256 }) });
    await index.index({ id: "d", text: "one two three four five six seven eight" });
    const first = index.size;
    await index.index({ id: "d", text: "short" });
    expect(index.size).toBeLessThanOrEqual(first);
    expect(index.vectorStore.chunks().every((c) => c.docId === "d")).toBe(true);
    // Only the new content remains.
    expect(index.vectorStore.chunks().map((c) => c.text)).toEqual(["short"]);
  });
});

// ── Index API: batched streaming embedding (aggregate-memory DoS guard) ──────

describe("RagIndex.index — batched streaming embedding", () => {
  /** Wraps an embedder, counting `embed()` calls and the size of each batch. */
  function countingWrap(inner: Embedder): { embedder: Embedder; calls: () => number; sizes: () => number[] } {
    let calls = 0;
    const sizes: number[] = [];
    const embedder: Embedder = {
      id: inner.id,
      dims: inner.dims,
      embed: async (texts: string[]) => {
        calls++;
        sizes.push(texts.length);
        return inner.embed(texts);
      },
    };
    return { embedder, calls: () => calls, sizes: () => sizes };
  }

  it("embeds a large corpus across multiple bounded batches instead of one giant call", async () => {
    const wrapped = countingWrap(createHashingEmbedder({ dims: 64 }));
    const doc: RagDocument = {
      id: "long-doc",
      text: Array.from(
        { length: 30 },
        (_, i) => `paragraph ${i} discusses topic number ${i % 5} in some depth and detail`,
      ).join("\n\n"),
    };

    const index = new RagIndex({
      embedder: wrapped.embedder,
      chunk: { chunkSize: 60, overlap: 10 },
      batchSize: 2,
    });
    const chunks = await index.index(doc);

    expect(chunks.length).toBeGreaterThan(4); // sanity: several chunks were produced
    expect(wrapped.calls()).toBeGreaterThan(1); // real batching occurred, not one shot
    expect(wrapped.sizes().every((n) => n <= 2)).toBe(true);
  });

  it("produces the SAME vectors and query results regardless of batch size (determinism preserved)", async () => {
    const doc: RagDocument = {
      id: "long-doc",
      text: Array.from(
        { length: 30 },
        (_, i) => `paragraph ${i} discusses topic number ${i % 5} in some depth and detail`,
      ).join("\n\n"),
    };
    const chunkOpts = { chunkSize: 60, overlap: 10 };

    // Baseline: batchSize large enough that the whole corpus is one batch.
    const singleWrap = countingWrap(createHashingEmbedder({ dims: 64 }));
    const single = new RagIndex({ embedder: singleWrap.embedder, chunk: chunkOpts, batchSize: 10_000 });
    const singleChunks = await single.index(doc);
    expect(singleWrap.calls()).toBe(1);

    // Same corpus, tiny batch size -> multiple embed() calls.
    const batchedWrap = countingWrap(createHashingEmbedder({ dims: 64 }));
    const batched = new RagIndex({ embedder: batchedWrap.embedder, chunk: chunkOpts, batchSize: 2 });
    const batchedChunks = await batched.index(doc);
    expect(batchedWrap.calls()).toBeGreaterThan(1);

    expect(batchedChunks.length).toBe(singleChunks.length);
    expect(batchedChunks.map((c) => c.id)).toEqual(singleChunks.map((c) => c.id));

    // Identical stored vectors per chunk id, whatever the batch size.
    const singleItems = new Map(single.vectorStore.toJSON().items.map((it) => [it.id, it]));
    const batchedItems = new Map(batched.vectorStore.toJSON().items.map((it) => [it.id, it]));
    expect([...batchedItems.keys()].sort()).toEqual([...singleItems.keys()].sort());
    for (const [id, item] of singleItems) {
      const other = batchedItems.get(id)!;
      expect(other.vector).toEqual(item.vector);
      expect(other.chunk.text).toEqual(item.chunk.text);
    }

    // Identical query results too.
    const q1 = await single.query("topic number 2", { topK: 3 });
    const q2 = await batched.query("topic number 2", { topK: 3 });
    expect(q2.map((r) => r.chunk.id)).toEqual(q1.map((r) => r.chunk.id));
    expect(q2.map((r) => r.score)).toEqual(q1.map((r) => r.score));
  });

  it("defaults to a batch size that still embeds a small corpus in a single call", async () => {
    const wrapped = countingWrap(createHashingEmbedder({ dims: 32 }));
    const index = new RagIndex({ embedder: wrapped.embedder });
    await index.index({ id: "d", text: "one two three four five six seven eight" });
    expect(wrapped.calls()).toBe(1);
  });
});

// ── Secret scanning / redaction (no-secret-persisted invariant) ───────────────

describe("secret redaction", () => {
  const SECRETS: Array<[string, string]> = [
    ["openai key", "const k = 'sk-proj-abcdef0123456789ABCDEFGHIJ';"],
    ["github pat", "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"],
    ["aws access key", "AWS_ACCESS_KEY_ID = AKIAIOSFODNN7EXAMPLE"],
    ["assignment", "PASSWORD=SuperSecretValue123"],
    [
      "pem private key",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
    ],
  ];

  it("redactSecrets replaces every known secret shape and containsSecret detects them", () => {
    for (const [, text] of SECRETS) {
      expect(containsSecret(text)).toBe(true);
      const red = redactSecrets(text);
      expect(red).toContain(SECRET_PLACEHOLDER);
      // The raw secret material is gone.
      expect(red).not.toMatch(/AKIA|ghp_|sk-proj-|SuperSecretValue|PRIVATE KEY-----[\s\S]*MIIE/);
    }
  });

  it("does not corrupt ordinary prose / code (no false positives)", () => {
    const clean = "function add(a, b) { return a + b; } // reads and writes files";
    expect(containsSecret(clean)).toBe(false);
    expect(redactSecrets(clean)).toBe(clean);
  });

  it("redaction is idempotent", () => {
    const once = redactSecrets("api_key = 'AKIAIOSFODNN7EXAMPLE'");
    expect(redactSecrets(once)).toBe(once);
  });

  it("a secret never reaches the embedder, the store, or persistence", async () => {
    const dir = freshDir();
    const file = join(dir, "rag-index.json");

    // A spy embedder that records every text it is asked to embed — this stands
    // in for the remote (ollama/openai) network round-trip.
    const seen: string[] = [];
    const spy: Embedder = {
      id: "spy-8",
      dims: 8,
      async embed(texts) {
        seen.push(...texts);
        return texts.map(() => new Array(8).fill(0));
      },
    };

    const raw = "config below\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\nsk-ABCDEFGHIJKLMNOPQRSTUVWX";
    const index = new RagIndex({ embedder: spy, file });
    await index.index({ id: "creds", text: raw, source: "creds.txt" });
    index.save();

    // (a) Nothing sensitive was sent to the embedder.
    const embedded = seen.join("\n");
    expect(embedded).not.toContain("wJalrXUtnFEMI");
    expect(embedded).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(embedded).toContain(SECRET_PLACEHOLDER);

    // (b) Nothing sensitive was persisted to rag-index.json.
    const onDisk = readFileSync(file, "utf8");
    expect(onDisk).not.toContain("wJalrXUtnFEMI");
    expect(onDisk).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");

    // (c) Retrieval surfaces only redacted text.
    const stored = index.vectorStore.chunks().map((c) => c.text).join("\n");
    expect(stored).not.toContain("wJalrXUtnFEMI");
    expect(stored).toContain(SECRET_PLACEHOLDER);
  });

  it("query() redacts a secret in the query text before embedding (no exfiltration)", async () => {
    const seen: string[] = [];
    const spy: Embedder = {
      id: "spy-query-8",
      dims: 8,
      async embed(texts) {
        seen.push(...texts);
        return texts.map(() => new Array(8).fill(0));
      },
    };
    const index = new RagIndex({ embedder: spy });
    await index.index({ id: "d", text: "reading and writing files to disk" });
    seen.length = 0; // ignore the index() embed call; only inspect the query() call

    const secretQuery = "here is my key sk-ABCDEFGHIJKLMNOPQRSTUVWX please use it";
    await index.query(secretQuery, { topK: 1 });

    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
    expect(seen[0]).toContain(SECRET_PLACEHOLDER);
  });

  it("query() passes a normal (secret-free) query through unchanged", async () => {
    const seen: string[] = [];
    const spy: Embedder = {
      id: "spy-query-plain-8",
      dims: 8,
      async embed(texts) {
        seen.push(...texts);
        return texts.map(() => new Array(8).fill(0));
      },
    };
    const index = new RagIndex({ embedder: spy });
    await index.index({ id: "d", text: "reading and writing files to disk" });
    seen.length = 0; // ignore the index() embed call; only inspect the query() call

    const plainQuery = "how do I write a file to the disk?";
    await index.query(plainQuery, { topK: 1 });

    expect(seen).toEqual([plainQuery]);
  });

  it("redactSecrets:false leaves text untouched (explicit opt-out)", async () => {
    const spy: string[] = [];
    const embedder: Embedder = {
      id: "spy2-8",
      dims: 8,
      async embed(texts) {
        spy.push(...texts);
        return texts.map(() => new Array(8).fill(0));
      },
    };
    const index = new RagIndex({ embedder, redactSecrets: false });
    await index.index({ id: "d", text: "TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" });
    expect(spy.join("")).toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
  });
});

// ── Context Engine bridge ─────────────────────────────────────────────────────

describe("RagRetrievalSource", () => {
  it("emits retrieved-lane chunks carrying citation metadata", async () => {
    const index = new RagIndex({ embedder: createHashingEmbedder({ dims: 512 }) });
    await index.index([
      { id: "files", text: "reading and writing files to disk", source: "files.md" },
      { id: "cake", text: "a chocolate cake recipe", source: "cake.md" },
    ]);
    const source = new RagRetrievalSource({ index, topK: 1 });
    expect(source.kind).toBe("volatile");

    const chunks = await source.collect({
      userMessage: "how to write a file to disk",
      cwd: process.cwd(),
      now: 0,
      estimate,
    });
    expect(chunks.length).toBe(1);
    const c = chunks[0]!;
    expect(c.lane).toBe("retrieved");
    expect(c.sourceId).toBe("rag");
    expect(c.meta?.docId).toBe("files");
    expect(c.meta?.source).toBe("files.md");
    expect(c.meta?.span).toMatchObject({ start: expect.any(Number), end: expect.any(Number) });
  });
});
