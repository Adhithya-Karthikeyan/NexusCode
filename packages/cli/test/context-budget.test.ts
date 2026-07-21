/**
 * Budget-enforcement regression (cost guard).
 *
 * `nexus agent` answering "Reply with one word: OK" cost $0.32 against `nexus
 * ask`'s $0.003, and the assembled project context was the suspect. It was not:
 * measured on the real repo the context engine packed 773 of a 4000-token budget,
 * and the repo map came in at 767 of its 768. What WAS broken is the relationship
 * between the two budgets:
 *
 *   - the TOTAL was a hard-coded `4000` at each `EngineContextAssembler` call
 *     site, absent from config and so impossible to lower,
 *   - the SUB-budget (`fileintel.budgetTokens`) was configurable and could be set
 *     ABOVE it, at which point the engine — which packs whole chunks and drops
 *     what will not fit — discarded the entire repo map. Asking for a bigger map
 *     produced no map, silently. Measured on this repo before the fix: 3900 →
 *     3898 tokens of map, 4096 → 0.
 *
 * These tests pin both halves: the total budget is real and configurable, and no
 * sub-budget setting can push a source off the cliff.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NexusConfig as NexusConfigSchema } from "@nexuscode/config";
import { ContextEngine } from "@nexuscode/context";

import { buildPowerSources, repoMapBudgetTokens } from "../src/power.js";
import { EngineContextAssembler } from "../src/commands.js";

let root: string;
let prevData: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nx-ctxbudget-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  prevData = process.env["NEXUS_DATA_DIR"];
  process.env["NEXUS_DATA_DIR"] = dataDir;

  // Enough structure that the repo map has real material to rank and truncate —
  // comfortably more than any budget under test could hold.
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  for (let i = 0; i < 300; i++) {
    writeFileSync(
      join(src, `mod${i}.ts`),
      `export function transform${i}(input: string): string {\n  return normalize${i}(input);\n}\n` +
        `export function normalize${i}(input: string): string {\n  return input.trim();\n}\n`,
    );
  }
  writeFileSync(join(root, "CLAUDE.md"), `# Rules\n${"always run the tests. ".repeat(2000)}`);
});

afterEach(() => {
  if (prevData === undefined) delete process.env["NEXUS_DATA_DIR"];
  else process.env["NEXUS_DATA_DIR"] = prevData;
  rmSync(root, { recursive: true, force: true });
});

describe("context.budgetTokens is the real, configurable ceiling", () => {
  it("defaults to a bounded value rather than being hard-coded at a call site", () => {
    expect(NexusConfigSchema.parse({}).context.budgetTokens).toBe(4096);
  });

  it("assembled context stays within the CONFIGURED budget, at every budget", async () => {
    for (const budgetTokens of [256, 1024, 4096, 16_384]) {
      const config = NexusConfigSchema.parse({ context: { budgetTokens } });
      const res = await new ContextEngine().assemble({
        budgetTokens: config.context.budgetTokens,
        sources: buildPowerSources(config, { cwd: root }),
        userMessage: "explain the module layout",
        cwd: root,
        now: 0,
      });
      expect(res.report.realTokens).toBeLessThanOrEqual(budgetTokens);
      expect(res.report.overBudget).toBe(false);
    }
  });

  it("end-to-end: what EngineContextAssembler hands the provider respects the budget", async () => {
    const budgetTokens = 1024;
    const config = NexusConfigSchema.parse({ context: { budgetTokens } });
    const assembler = new EngineContextAssembler(
      new ContextEngine(),
      buildPowerSources(config, { cwd: root }),
      config.context.budgetTokens,
    );

    const out = await assembler.assemble(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "Reply with one word: OK" }] }],
        system: "You are NexusCode.",
      },
      new AbortController().signal,
    );

    // The context the assembler ADDS is what the budget governs — the caller's
    // own system prompt and conversation are not the engine's to trim.
    const added = (out.system ?? "").replace("You are NexusCode.", "");
    expect(Math.ceil(added.length / 4)).toBeLessThanOrEqual(budgetTokens);
  });
});

describe("no sub-budget setting can silently delete a source", () => {
  it("the repo map survives even when fileintel.budgetTokens exceeds the total", async () => {
    // 4096 (== the default total) and 8192 (double it) both used to yield ZERO
    // tokens of repo map: the chunk did not fit, so the engine dropped all of it.
    for (const fileintelBudget of [768, 2048, 4096, 8192]) {
      const config = NexusConfigSchema.parse({ fileintel: { budgetTokens: fileintelBudget } });
      const res = await new ContextEngine().assemble({
        budgetTokens: config.context.budgetTokens,
        sources: buildPowerSources(config, { cwd: root }),
        userMessage: "explain the module layout",
        cwd: root,
        now: 0,
      });
      const lane = res.report.lanes.find((l) => l.lane === "repo-map");
      expect(lane?.tokens ?? 0).toBeGreaterThan(0);
      expect(res.report.realTokens).toBeLessThanOrEqual(config.context.budgetTokens);
    }
  });

  it("clamps the repo map to half the context budget, and never above its own setting", () => {
    // Below the ceiling the setting is honoured verbatim…
    expect(
      repoMapBudgetTokens(NexusConfigSchema.parse({ context: { budgetTokens: 4096 } })),
    ).toBe(768);
    // …above it the ceiling wins, leaving the other half for conventions, git,
    // and the user's own message.
    expect(
      repoMapBudgetTokens(
        NexusConfigSchema.parse({ context: { budgetTokens: 4096 }, fileintel: { budgetTokens: 9999 } }),
      ),
    ).toBe(2048);
    // A tiny total budget still yields a positive, usable cap.
    expect(
      repoMapBudgetTokens(NexusConfigSchema.parse({ context: { budgetTokens: 1 } })),
    ).toBe(1);
  });
});
