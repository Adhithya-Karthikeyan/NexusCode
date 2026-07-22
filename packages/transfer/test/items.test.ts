import { describe, it, expect } from "vitest";
import {
  makeEmbeddingKey,
  stableFieldsOf,
  tagReasoning,
  NEVER_COMPRESS_KINDS,
  ulid,
  type KnowledgeItem,
} from "../src/items.js";

describe("makeEmbeddingKey", () => {
  it("concatenates title + body + whyGloss + tags, lowercased", () => {
    const key = makeEmbeddingKey({
      title: "Use SQLite",
      body: "Because Durability",
      whyGloss: ["Fast", "Local"],
      tags: ["db", "Core"],
    });
    expect(key).toBe("use sqlite because durability fast local db core");
  });

  it("works without whyGloss/tags", () => {
    expect(makeEmbeddingKey({ title: "Hi", body: "There" })).toBe("hi there  ");
  });
});

describe("stableFieldsOf", () => {
  function buildItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
    return {
      id: "k1",
      kind: "decision",
      scope: "session",
      title: "T",
      body: "B",
      importance: 0.9,
      confidence: 0.5,
      staleness: 0.2,
      status: "active",
      revision: 1,
      createdAt: 1,
      updatedAt: 2,
      lastVerifiedAt: 3,
      links: [],
      tags: ["x"],
      embeddingKey: "k1 b",
      source: { origin: "user", ref: "u1" },
      ...overrides,
    };
  }

  it("excludes maintained fields (importance/staleness/confidence/lastVerifiedAt)", () => {
    const a = stableFieldsOf(buildItem({ importance: 0.1, confidence: 0.1, staleness: 0.1, lastVerifiedAt: 10 }));
    const b = stableFieldsOf(buildItem({ importance: 0.9, confidence: 0.9, staleness: 0.9, lastVerifiedAt: 999 }));
    expect(a).toBe(b);
  });

  it("includes stable fields (body/revision/status/links/source)", () => {
    const a = stableFieldsOf(buildItem({ body: "X" }));
    const b = stableFieldsOf(buildItem({ body: "Y" }));
    expect(a).not.toBe(b);
  });
});

describe("tagReasoning", () => {
  it("non-empty text → origin inferred, confidence 0.4", () => {
    const r = tagReasoning({ text: "We chose SQLite because durability matters. It is fast." });
    expect(r.origin).toBe("inferred");
    expect(r.confidence).toBe(0.4);
    expect(r.why).toBe("We chose SQLite because durability matters.");
    expect(r.coverage).toBeGreaterThan(0);
    expect(r.coverage!).toBeLessThanOrEqual(1);
  });

  it("empty text → origin unavailable, confidence 0", () => {
    const r = tagReasoning({ text: "" });
    expect(r.origin).toBe("unavailable");
    expect(r.confidence).toBe(0);
    expect(r.why).toBe("[unavailable]");
  });

  it("lifts alternatives from provided list", () => {
    const r = tagReasoning({ text: "Pick A.", alternatives: ["B", "C"] });
    expect(r.alternatives.map((a) => a.option)).toEqual(["B", "C"]);
  });
});

describe("NEVER_COMPRESS_KINDS", () => {
  it("contains the immortal kinds + file-fact", () => {
    expect(NEVER_COMPRESS_KINDS).toContain("decision");
    expect(NEVER_COMPRESS_KINDS).toContain("failure");
    expect(NEVER_COMPRESS_KINDS).toContain("assumption");
    expect(NEVER_COMPRESS_KINDS).toContain("intent");
    expect(NEVER_COMPRESS_KINDS).toContain("convention");
    expect(NEVER_COMPRESS_KINDS).toContain("constraint");
    expect(NEVER_COMPRESS_KINDS).toContain("file-fact");
  });
});

describe("ulid", () => {
  it("produces a 26-char Crockford string", () => {
    const id = ulid();
    expect(id.length).toBe(26);
    expect(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)).toBe(true);
  });
});