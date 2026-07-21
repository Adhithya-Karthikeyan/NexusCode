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
 *     produced no map, silently. Measured on this repo against that hard-coded
 *     4000: `fileintel.budgetTokens` 3900 gave 3898 tokens of map, 4096 gave 0.
 *
 * These tests pin both halves: the total budget is real and configurable, and no
 * sub-budget setting can push a source off the cliff.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NexusConfig as NexusConfigSchema } from "@nexuscode/config";
import { ContextEngine } from "@nexuscode/context";
import {
  ProviderRegistry,
  createEngine,
  dispatchAgent,
  type ProviderAdapter,
} from "@nexuscode/core";
import { createMockAdapter } from "@nexuscode/provider-mock";
import { PermissionGate, ToolRegistry, type Tool } from "@nexuscode/tools";
import type { ChatRequest } from "@nexuscode/shared";

import { buildPowerSources, repoMapBudgetTokens } from "../src/power.js";
import { EngineContextAssembler } from "../src/commands.js";

/** char/4, the Context Engine's own estimator — the unit every budget is stated in. */
function est(s: string | undefined): number {
  return Math.ceil((s ?? "").length / 4);
}

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

  it("the STATIC prefix — where the repo map actually goes — stays within fileintel.budgetTokens", async () => {
    // The component assertion. Static lanes serialize into `system`, NOT into
    // `messages`, which is why inspecting the assembled user turn showed nothing
    // and the repo map looked absent. Assert on the prefix itself.
    //
    // Stated allowance: the engine wraps each lane in a `# <Lane Title>\n` header,
    // so the rendered prefix runs a few tokens over the raw chunk budget. 64 tokens
    // covers the headers for every lane the default config can produce.
    const config = NexusConfigSchema.parse({});
    const res = await new ContextEngine().assemble({
      budgetTokens: config.context.budgetTokens,
      sources: buildPowerSources(config, { cwd: root }),
      userMessage: "explain the module layout",
      cwd: root,
      now: 0,
    });

    const repoMapLane = res.report.lanes.find((l) => l.lane === "repo-map");
    expect(repoMapLane!.tokens).toBeLessThanOrEqual(repoMapBudgetTokens(config));
    // And the rendered prefix — the bytes that genuinely leave the process.
    expect(est(res.system)).toBeLessThanOrEqual(res.report.staticTokens + 64);
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

describe("what the agent path actually puts on the wire", () => {
  /** Records every outgoing `ChatRequest` so each component can be measured apart. */
  function spyAdapter(): { adapter: ProviderAdapter; requests: ChatRequest[] } {
    const base = createMockAdapter({ id: "spy" });
    const requests: ChatRequest[] = [];
    return {
      requests,
      adapter: {
        ...base,
        chat(req, c) {
          requests.push(structuredClone(req));
          return base.chat(req, c);
        },
        stream(req, c) {
          requests.push(structuredClone(req));
          return base.stream(req, c);
        },
      },
    };
  }

  /** A no-op tool whose schema is representative of a bridged MCP tool. */
  function fatTool(n: number): Tool {
    return {
      name: `mcp_tool_${n}`,
      description: `Tool number ${n}. ${"Detailed usage guidance for the model. ".repeat(12)}`,
      parameters: {
        type: "object",
        properties: {
          project: { type: "string", description: "The project to operate on." },
          query: { type: "string", description: "What to look for." },
        },
        required: ["project"],
      },
      permission: "read",
      async run() {
        return { ok: true, content: [{ type: "text", text: "ok" }] };
      },
    };
  }

  const SYSTEM = "You are NexusCode.";

  /** One agent dispatch; returns the first outgoing request. */
  async function dispatch(tools: ToolRegistry, sources = buildPowerSources(NexusConfigSchema.parse({}), { cwd: root })) {
    const { adapter, requests } = spyAdapter();
    const registry = new ProviderRegistry();
    await registry.register(adapter, { skipHealth: true });
    const config = NexusConfigSchema.parse({});
    const engine = createEngine({
      registry,
      contextAssembler: new EngineContextAssembler(
        new ContextEngine(),
        sources,
        config.context.budgetTokens,
      ),
    });
    const session = await engine.openSession();
    const turn = session.newTurn({ prompt: "Reply with one word: OK" });
    const handle = dispatchAgent(
      {
        adapterId: "spy",
        model: "mock-fast",
        input: turn.input,
        idempotencyKey: randomUUID(),
        params: { system: SYSTEM },
      },
      turn.context(),
      { tools, gate: new PermissionGate({ mode: "read-only" }) },
    );
    for await (const _ of handle.events()) {
      /* drain */
    }
    await session.dispose();
    await engine.dispose();
    return requests[0]!;
  }

  it("puts project context in `system`, not in `messages` — which is why it looked absent", async () => {
    const req = await dispatch(new ToolRegistry());
    // The repo map is a STATIC lane: it rides the cache-stable system prefix.
    // Inspecting the assembled user turn (what the mock echo prints) shows a
    // trivial message and hides the entire context cost. That is by design, and
    // it is the reason this cost went unattributed for so long.
    expect(req.system ?? "").toContain("mod0.ts");
    expect(est(req.system)).toBeGreaterThan(est(SYSTEM));
    expect(JSON.stringify(req.messages)).not.toContain("mod0.ts");
    expect(est(JSON.stringify(req.messages))).toBeLessThan(64);
  });

  it("the context budget governs `system` only — tool definitions are outside it, by design", async () => {
    const config = NexusConfigSchema.parse({});

    const bare = new ToolRegistry();
    const withTools = new ToolRegistry();
    for (let i = 0; i < 16; i++) withTools.register(fatTool(i));

    const reqBare = await dispatch(bare);
    const reqTools = await dispatch(withTools);

    // The context contribution is IDENTICAL either way: registering 16 tools adds
    // nothing to the assembled prefix, so no amount of budget tuning can shrink
    // them. They are a separate, legitimate cost of having those tools available.
    expect(est(reqTools.system)).toBe(est(reqBare.system));

    // The assembled prefix stays inside the context budget…
    expect(est(reqBare.system) - est(SYSTEM)).toBeLessThanOrEqual(config.context.budgetTokens);
    // …while the tool schemas, which it does NOT govern, are the larger term.
    // 16 MCP-shaped tools cost multiples of the whole repo map. This assertion is
    // the guard: if tool definitions ever start being counted as context (or the
    // context starts leaking into them), one of these two numbers moves.
    const toolTokens = est(JSON.stringify(reqTools.tools));
    const contextTokens = est(reqBare.system) - est(SYSTEM);
    expect(toolTokens).toBeGreaterThan(contextTokens);
    expect(est(JSON.stringify(reqBare.tools ?? []))).toBeLessThan(8);
  });
});
