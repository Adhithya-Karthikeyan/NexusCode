/**
 * Prefix-cache + prompt-cache tests: breakpoints/keys are stable across
 * identical static context, the stability contract holds, and Anthropic
 * cache_control is injected on the correct boundaries. Uses the real
 * ContextEngine so the stability guarantee is verified end-to-end.
 */

import { describe, expect, it } from "vitest";
import { ContextEngine } from "@nexuscode/context";
import type { ContextSource } from "@nexuscode/context";
import {
  PREFIX_STABILITY_CONTRACT,
  assertStablePrefix,
  buildPrefixCachePlan,
  prefixCacheKey,
  toAnthropicSystem,
} from "../src/prefix.js";
import { MemoryCache } from "../src/backends/memory.js";
import { PromptCache } from "../src/typed/prompt.js";
import type { PromptCacheValue } from "../src/typed/prompt.js";

/** A fixed static source (no timestamps) so the prefix is byte-stable. */
function staticSource(): ContextSource {
  return {
    id: "conventions",
    priority: 10,
    kind: "static",
    async collect() {
      return [
        { id: "c1", lane: "conventions", text: "Always write tests." },
        { id: "c2", lane: "repo-map", text: "src/index.ts — entry point" },
      ];
    },
  };
}

/** A volatile source whose content differs per call. */
function volatileSource(tag: string): ContextSource {
  return {
    id: "task",
    priority: 1,
    kind: "volatile",
    async collect() {
      return [{ id: `t-${tag}`, lane: "task", text: `working on ${tag}` }];
    },
  };
}

async function assembleTwice() {
  const engine = new ContextEngine();
  const a = await engine.assemble({
    budgetTokens: 10_000,
    userMessage: "do the thing",
    sources: [staticSource(), volatileSource("alpha")],
    now: 1_000,
  });
  const b = await engine.assemble({
    budgetTokens: 10_000,
    userMessage: "do a different thing",
    sources: [staticSource(), volatileSource("beta")],
    now: 9_999,
  });
  return { a, b };
}

describe("prefix stability contract", () => {
  it("exposes the static-first / trim-tail invariant as data", () => {
    expect(PREFIX_STABILITY_CONTRACT.staticFirst).toBe(true);
    expect(PREFIX_STABILITY_CONTRACT.trimTailOnly).toBe(true);
    expect(PREFIX_STABILITY_CONTRACT.noVolatileTokensInPrefix).toBe(true);
    expect(PREFIX_STABILITY_CONTRACT.maxBreakpoints).toBe(4);
  });

  it("keeps the system prefix byte-identical across identical static context", async () => {
    const { a, b } = await assembleTwice();
    expect(a.system).toBe(b.system);
    const { fullyStable, sharedPrefixLength } = assertStablePrefix(a.system, b.system);
    expect(fullyStable).toBe(true);
    expect(sharedPrefixLength).toBe(a.system.length);
  });

  it("produces stable cache keys and breakpoints across identical static context", async () => {
    const { a, b } = await assembleTwice();
    expect(prefixCacheKey(a.system)).toBe(prefixCacheKey(b.system));

    const offA = a.report.breakpoints.map((x) => x.tokenOffset);
    const offB = b.report.breakpoints.map((x) => x.tokenOffset);
    expect(offA).toEqual(offB);

    const planA = buildPrefixCachePlan(a.system, offA);
    const planB = buildPrefixCachePlan(b.system, offB);
    expect(planA.key).toBe(planB.key);
    expect(planA.breakpoints).toEqual(planB.breakpoints);
    expect(planA.stable).toBe(true);
  });
});

describe("toAnthropicSystem", () => {
  it("marks the whole prefix as one ephemeral cache block by default", () => {
    const blocks = toAnthropicSystem("STATIC PREFIX");
    expect(blocks).toEqual([{ type: "text", text: "STATIC PREFIX", cache_control: { type: "ephemeral" } }]);
  });

  it("marks the trailing N segments when given lane segments", () => {
    const blocks = toAnthropicSystem(["sys", "tools", "memory"], { maxBreakpoints: 2 });
    expect(blocks[0].cache_control).toBeUndefined();
    expect(blocks[1].cache_control).toEqual({ type: "ephemeral" });
    expect(blocks[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("clamps breakpoints to the Anthropic cap of 4 and drops empty segments", () => {
    const blocks = toAnthropicSystem(["a", "", "b", "c", "d", "e"], { maxBreakpoints: 99 });
    expect(blocks).toHaveLength(5); // empty dropped
    expect(blocks.filter((b) => b.cache_control).length).toBe(4); // clamped to 4
  });
});

describe("PromptCache", () => {
  it("caches a rendered static prefix keyed by its content", async () => {
    const cache = new PromptCache({ backend: new MemoryCache<PromptCacheValue>() });
    const { a } = await assembleTwice();
    const value: PromptCacheValue = {
      system: a.system,
      tokens: a.report.stablePrefixTokens,
      breakpoints: a.report.breakpoints.map((x) => x.tokenOffset),
    };
    expect(await cache.get("claude-x", a.system)).toBeUndefined();
    await cache.set("claude-x", value);
    expect(await cache.get("claude-x", a.system)).toEqual(value);

    const stats = await cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.savedInputTokens).toBe(value.tokens);
  });
});
