/**
 * `/model` + `/provider` switch preflight (packages/cli/src/model-switch.ts).
 *
 * The reported bug: picking a different model in the TUI's `/model` picker did
 * nothing — no switch, no message. Cause: the picker is populated from the
 * provider's LIVE `adapter.listModels()` catalog (Anthropic's `/v1/models`
 * returns dated ids like `claude-sonnet-4-5-20250929`) while the preflight
 * validated the pick against the CURATED `capabilities().models` snapshot
 * (undated aliases like `claude-sonnet-4-5`). The two sets barely overlap, so
 * nearly every visible model was rejected as "does not advertise model …".
 *
 * These tests drive the REAL preflight against a REAL offline runtime with a
 * provider that reproduces exactly that curated-vs-live mismatch.
 */
import { describe, it, expect } from "vitest";
import { NexusConfig, type SecretStore } from "@nexuscode/config";
import { buildRuntime } from "@nexuscode/runtime";
import type { CallContext, ModelInfo, ProviderAdapter, TransportKind } from "@nexuscode/core";
import type { Message } from "@nexuscode/shared";
import { listModelsForProvider } from "../src/runtime.js";
import {
  DEFAULT_CONTEXT_WINDOW,
  ModelCatalog,
  contextWindowFor,
  implicitEffortDefaultFor,
  preflightModelSwitch,
  preflightProviderSwitch,
  reasoningSupportedFor,
  resolveSwitchModel,
  type SwitchContext,
} from "../src/model-switch.js";

const stubSecrets: SecretStore = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  source: async () => null,
};

/** A provider whose LIVE list is disjoint from its CURATED list (the real bug). */
function mismatchedAdapter(id: string): ProviderAdapter {
  return {
    id,
    label: id,
    transport: "http-sdk",
    capabilities: async () => ({
      // Curated snapshot: undated aliases, exactly like DEFAULT_ANTHROPIC_MODELS.
      models: [{ id: "claude-sonnet-4-5", contextWindow: 200_000 }],
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      vision: true,
      structuredOutput: false,
      reasoning: true,
      systemPrompt: true,
      fileEdit: false,
      shellExec: false,
      git: false,
      approvalGate: false,
      mcp: true,
      cancel: "abort-signal",
    }),
    chat: async () => {
      throw new Error("unused");
    },
    // eslint-disable-next-line require-yield
    async *stream() {
      throw new Error("unused");
    },
    // Live `/v1/models`: dated ids the curated snapshot has never heard of.
    listModels: async (_ctx?: CallContext): Promise<ModelInfo[]> => [
      { id: "claude-opus-4-5-20251101", contextWindow: 1_000_000 },
      { id: "claude-sonnet-4-5-20250929", contextWindow: 200_000 },
      { id: "claude-haiku-4-5-20251001" },
    ],
  };
}

async function fixture(configPatch: Record<string, unknown> = {}) {
  const config = NexusConfig.parse({ defaultProvider: "mock", ...configPatch });
  const runtime = await buildRuntime(config, { secrets: stubSecrets });
  await runtime.registry.register(mismatchedAdapter("live-anthropic"), { skipHealth: true });
  runtime.statuses.push({
    id: "live-anthropic",
    kind: "anthropic",
    available: true,
    detail: "test",
  } as (typeof runtime.statuses)[number]);
  const catalog = new ModelCatalog();
  const ctx = (from = { provider: "live-anthropic", model: "claude-sonnet-4-5" }): SwitchContext => ({
    runtime,
    config,
    catalog,
    from,
  });
  return { runtime, config, catalog, ctx };
}

/** Load the picker's rows exactly as `cmdTui` does, recording them in the catalog. */
async function openPicker(
  runtime: Awaited<ReturnType<typeof fixture>>["runtime"],
  catalog: ModelCatalog,
  providerId: string,
): Promise<string[]> {
  const rows = await listModelsForProvider(runtime, providerId);
  catalog.record(providerId, rows);
  return rows.map((r) => r.model);
}

describe("/model switch preflight", () => {
  it("ACCEPTS a live-discovered model the curated capabilities never list (the bug)", async () => {
    const { runtime, catalog, ctx } = await fixture();

    // The user opens `/model` and sees the live catalog.
    const offered = await openPicker(runtime, catalog, "live-anthropic");
    expect(offered).toContain("claude-opus-4-5-20251101");
    // …which is NOT in the curated snapshot the old preflight validated against.
    expect(runtime.registry.capabilitiesOf("live-anthropic").models.map((m) => m.id)).not.toContain(
      "claude-opus-4-5-20251101",
    );

    // Picking it must WORK, not be rejected as "does not advertise".
    const result = preflightModelSwitch(ctx(), "claude-opus-4-5-20251101", "live-anthropic");
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.model).toBe("claude-opus-4-5-20251101");
    expect(result.provider).toBe("live-anthropic");
    expect(result.receipt).toContain("live-anthropic/claude-sonnet-4-5 → live-anthropic/claude-opus-4-5-20251101");
  });

  it("sizes the context window from the model actually picked, not the first curated one", async () => {
    const { runtime, catalog, ctx } = await fixture();
    await openPicker(runtime, catalog, "live-anthropic");

    const result = preflightModelSwitch(ctx(), "claude-opus-4-5-20251101", "live-anthropic");
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    // The picked model's REAL window (1M), not the curated model[0]'s 200k.
    expect(result.contextMax).toBe(1_000_000);
  });

  it("falls back to a neutral default (never another model's window) for an unknown size", async () => {
    const { runtime, catalog } = await fixture();
    await openPicker(runtime, catalog, "live-anthropic");
    // `claude-haiku-4-5-20251001` reports no contextWindow at all.
    expect(contextWindowFor(runtime, "live-anthropic", "claude-haiku-4-5-20251001", catalog)).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
    // And a model this provider has never mentioned does not inherit one either.
    expect(contextWindowFor(runtime, "live-anthropic", "never-heard-of-it", catalog)).toBe(
      DEFAULT_CONTEXT_WINDOW,
    );
  });

  it("still accepts a curated alias the live list omits", async () => {
    const { catalog, ctx } = await fixture();
    // Picker never opened: the catalog is empty, curated is the only source.
    expect(catalog.first("live-anthropic")).toBeUndefined();
    const result = preflightModelSwitch(ctx(), "claude-sonnet-4-5", "live-anthropic");
    expect(result.accepted).toBe(true);
  });

  it("REJECTS a model neither the picker nor the capabilities know", async () => {
    const { runtime, catalog, ctx } = await fixture();
    await openPicker(runtime, catalog, "live-anthropic");

    const result = preflightModelSwitch(ctx(), "gpt-4o", "live-anthropic");
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toContain("gpt-4o");
  });

  it("REJECTS a switch to an unusable provider", async () => {
    const { ctx } = await fixture();
    const result = preflightModelSwitch(ctx(), "anything", "not-registered");
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toContain("unavailable");
  });

  it("REJECTS a target the circuit breaker has blocked, naming the retry time", async () => {
    const { catalog, runtime, config } = await fixture();
    await openPicker(runtime, catalog, "live-anthropic");
    const blockedCtx: SwitchContext = {
      runtime,
      config,
      catalog,
      circuit: {
        status: () =>
          ({
            key: "k",
            target: { providerId: "live-anthropic" },
            state: "open",
            availability: "blocked",
            attempts: 1,
            openCount: 1,
            retryAt: 1_700_000_000_000,
          }) as ReturnType<NonNullable<SwitchContext["circuit"]>["status"]>,
      },
      from: { provider: "live-anthropic", model: "claude-sonnet-4-5" },
    };
    const result = preflightModelSwitch(blockedCtx, "claude-opus-4-5-20251101", "live-anthropic");
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toContain("unavailable");
    expect(result.reason).toContain("until");
  });
});

describe("/provider switch preflight", () => {
  it("lands on a model the TARGET provider has, not a foreign global defaultModel", async () => {
    // `defaultModel` is a single global setting; it belonged to the OLD provider.
    const { runtime, catalog, ctx } = await fixture({ defaultModel: "gpt-4o" });
    await openPicker(runtime, catalog, "live-anthropic");

    const result = preflightProviderSwitch(
      { ...ctx({ provider: "mock", model: "mock-fast" }) },
      "live-anthropic",
    );
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    // NOT "gpt-4o" — that id would have been carried across and failed at dispatch.
    expect(result.model).not.toBe("gpt-4o");
    expect(result.model).toBe("claude-opus-4-5-20251101");
  });

  it("honors a global defaultModel when the target provider really offers it", async () => {
    const { runtime, catalog, ctx } = await fixture({ defaultModel: "claude-sonnet-4-5-20250929" });
    await openPicker(runtime, catalog, "live-anthropic");

    const result = preflightProviderSwitch(ctx({ provider: "mock", model: "mock-fast" }), "live-anthropic");
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("falls back to the curated first model when the picker never loaded that provider", async () => {
    const { runtime, config, catalog } = await fixture();
    expect(resolveSwitchModel(runtime, "live-anthropic", config, catalog)).toBe("claude-sonnet-4-5");
  });

  it("reports the TARGET provider's reasoning support, not the one being left", async () => {
    const { runtime, ctx } = await fixture();
    // Ground truth straight from each provider's declared capabilities.
    const mockReasoning = runtime.registry.capabilitiesOf("mock").reasoning === true;
    expect(runtime.registry.capabilitiesOf("live-anthropic").reasoning).toBe(true);

    const toMock = preflightProviderSwitch(ctx(), "mock");
    expect(toMock.accepted).toBe(true);
    if (!toMock.accepted) return;
    expect(toMock.reasoningSupported).toBe(mockReasoning);

    const toLive = preflightProviderSwitch(ctx({ provider: "mock", model: "mock-fast" }), "live-anthropic");
    expect(toLive.accepted).toBe(true);
    if (!toLive.accepted) return;
    expect(toLive.reasoningSupported).toBe(true);
  });

  it("REJECTS an unusable provider", async () => {
    const { ctx } = await fixture();
    const result = preflightProviderSwitch(ctx(), "definitely-not-installed");
    expect(result.accepted).toBe(false);
  });
});

/**
 * GAPS G19 (`docs/CAPABILITIES.md`): the TUI picker used to check only
 * provider-usable / model-advertised / circuit-blocked — none of
 * `assessSwitchTarget`'s blockers (modality, tools, structured output,
 * reasoning, context window, cost). These tests prove the picker now
 * inherits them via `ctx.transcript`, the same way `chat --persistent`'s
 * explicit switch control line already did (`commands.ts`'s `performSwitch`).
 */
describe("/model + /provider switch preflight — inherits assessSwitchTarget (GAPS G19)", () => {
  const TOOL_USE_MSG: Message = {
    role: "assistant",
    content: [{ type: "tool_use", id: "call_1", name: "echo", input: {} }],
  };
  const TOOL_RESULT_MSG: Message = {
    role: "tool",
    toolCallId: "call_1",
    content: [{ type: "text", text: "echoed" }],
  };

  function noToolsAdapter(id: string): ProviderAdapter {
    return {
      id,
      label: id,
      transport: "http-sdk",
      capabilities: async () => ({
        models: [{ id: "plain-model", contextWindow: 200_000 }],
        streaming: true,
        tools: false,
        parallelToolCalls: false,
        vision: false,
        structuredOutput: false,
        reasoning: false,
        systemPrompt: true,
        fileEdit: false,
        shellExec: false,
        git: false,
        approvalGate: false,
        mcp: false,
        cancel: "abort-signal",
      }),
      chat: async () => {
        throw new Error("unused");
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("unused");
      },
    };
  }

  async function fixtureWithPlainProvider() {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    await runtime.registry.register(noToolsAdapter("plain-only"), { skipHealth: true });
    const catalog = new ModelCatalog();
    return { runtime, config, catalog };
  }

  it("REJECTS a /model pick that can't accept tool-call history already in the conversation", async () => {
    const { runtime, config, catalog } = await fixtureWithPlainProvider();
    const ctx: SwitchContext = {
      runtime,
      config,
      catalog,
      from: { provider: "mock", model: "mock-fast" },
      transcript: [TOOL_USE_MSG, TOOL_RESULT_MSG],
    };
    const result = preflightModelSwitch(ctx, "plain-model", "plain-only");
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toContain("plain-only");
    expect(result.reason).toContain("stay on the current provider");
    expect(result.reason).toContain("start a new conversation without that history");
  });

  it("REJECTS a /provider pick for the same reason", async () => {
    const { runtime, config, catalog } = await fixtureWithPlainProvider();
    const ctx: SwitchContext = {
      runtime,
      config,
      catalog,
      from: { provider: "mock", model: "mock-fast" },
      transcript: [TOOL_USE_MSG, TOOL_RESULT_MSG],
    };
    const result = preflightProviderSwitch(ctx, "plain-only");
    expect(result.accepted).toBe(false);
    if (result.accepted) return;
    expect(result.reason).toContain("tool-call history");
  });

  it("ACCEPTS the same pick when the conversation has no tool history yet", async () => {
    const { runtime, config, catalog } = await fixtureWithPlainProvider();
    const ctx: SwitchContext = {
      runtime,
      config,
      catalog,
      from: { provider: "mock", model: "mock-fast" },
      transcript: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    };
    const result = preflightModelSwitch(ctx, "plain-model", "plain-only");
    expect(result.accepted).toBe(true);
  });

  it("ACCEPTS with a visible WARNING (not a block) when the target needs history compaction", async () => {
    // A target with a tiny context window: assessSwitchTarget warns rather
    // than blocks — an interactive picker is exactly where that is useful
    // ("this model has a smaller context window") rather than noise.
    const { runtime, config, catalog } = await fixture();
    const bigText = "x".repeat(4_000);
    const ctx: SwitchContext = {
      runtime,
      config,
      catalog,
      from: { provider: "mock", model: "mock-fast" },
      transcript: [{ role: "user", content: [{ type: "text", text: bigText }] }],
    };
    // `live-anthropic`'s curated model has a 200k window — plenty. Register a
    // second, tiny-window variant of the same shape to force the warning.
    await runtime.registry.register(
      {
        ...noToolsAdapter("tiny-window"),
        capabilities: async () => ({
          models: [{ id: "plain-model", contextWindow: 64 }],
          streaming: true,
          tools: true,
          parallelToolCalls: false,
          vision: false,
          structuredOutput: false,
          reasoning: false,
          systemPrompt: true,
          fileEdit: false,
          shellExec: false,
          git: false,
          approvalGate: false,
          mcp: false,
          cancel: "abort-signal",
        }),
      },
      { skipHealth: true },
    );
    const result = preflightModelSwitch(ctx, "plain-model", "tiny-window");
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.receipt).toContain("compaction");
  });

  it("degrades to the pre-existing usable/advertised/circuit-only preflight when no transcript is supplied (no live session)", async () => {
    // Every pre-G19 test in this file omits `transcript` entirely and still
    // passes unchanged — this test makes that contract explicit rather than
    // leaving it implied by the rest of the file.
    const { runtime, config, catalog } = await fixtureWithPlainProvider();
    const ctx: SwitchContext = { runtime, config, catalog, from: { provider: "mock", model: "mock-fast" } };
    const result = preflightModelSwitch(ctx, "plain-model", "plain-only");
    expect(result.accepted).toBe(true);
  });
});

/**
 * `reasoningSupportedFor` — the ONE predicate the `--effort` CLI flag
 * (`applyEffort` in commands.ts) and the TUI's `/effort` picker both consult.
 *
 * The reported gap: `capabilities().reasoning: true` alone does not mean a
 * reasoning EFFORT actually reaches the wire. Two transport families
 * advertise it without honoring it as request input — a wrapped coding CLI
 * (cli-subprocess) and the generic OpenAI-compatible transport unless its
 * config explicitly opts into `supportsReasoningEffort` (no compat spec does
 * today — see DeepSeek in `packages/providers/openai/src/compat.ts`). Both
 * cases used to slip through as "supported" and silently drop the value.
 */
describe("reasoningSupportedFor — effort must actually reach the wire", () => {
  function adapterWith(id: string, transport: TransportKind, reasoning: boolean): ProviderAdapter {
    return {
      id,
      label: id,
      transport,
      capabilities: async () => ({
        models: [],
        streaming: true,
        tools: false,
        parallelToolCalls: false,
        vision: false,
        structuredOutput: false,
        reasoning,
        systemPrompt: true,
        fileEdit: false,
        shellExec: false,
        git: false,
        approvalGate: false,
        mcp: false,
        cancel: "abort-signal",
      }),
      chat: async () => {
        throw new Error("unused");
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("unused");
      },
    };
  }

  it("TRUE for a real http-sdk provider that declares reasoning", async () => {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    await runtime.registry.register(adapterWith("thinky", "http-sdk", true), { skipHealth: true });
    expect(reasoningSupportedFor(runtime, "thinky")).toBe(true);
  });

  it("FALSE for a cli-subprocess provider (codex/claude-code) even though it declares reasoning", async () => {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    await runtime.registry.register(adapterWith("wrapped-cli", "cli-subprocess", true), { skipHealth: true });
    expect(reasoningSupportedFor(runtime, "wrapped-cli")).toBe(false);
  });

  it("FALSE for an http-openai-compat provider (e.g. DeepSeek) even though it declares reasoning", async () => {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    await runtime.registry.register(adapterWith("deepseek-like", "http-openai-compat", true), {
      skipHealth: true,
    });
    expect(reasoningSupportedFor(runtime, "deepseek-like")).toBe(false);
  });

  it("FALSE when the provider does not declare reasoning at all", async () => {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    expect(reasoningSupportedFor(runtime, "mock")).toBe(false);
  });

  it("FALSE for an unknown provider id (never throws)", async () => {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    expect(reasoningSupportedFor(runtime, "does-not-exist")).toBe(false);
  });

  /**
   * The restoration this test locks in: a `cli-subprocess` provider is no
   * longer BLANKET-excluded. claude-code/codex now wire `--effort`/`-c
   * model_reasoning_effort=…` for real (see each adapter's `buildArgs`), and
   * that IS exactly what implementing `listReasoningLevels` signals — so a
   * `cli-subprocess` adapter that has it is TRUE here, structurally, with no
   * id/kind guesswork. The neighboring "FALSE …even though it declares
   * reasoning" test above still passes unmodified: a `cli-subprocess`
   * adapter WITHOUT `listReasoningLevels` (e.g. a future wrapped CLI that
   * hasn't wired it yet) stays FALSE automatically.
   */
  it("TRUE for a cli-subprocess provider that DOES implement listReasoningLevels (claude-code/codex's real wiring)", async () => {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    const adapter = adapterWith("wired-cli", "cli-subprocess", true);
    adapter.listReasoningLevels = async () => ({ levels: [{ id: "xhigh" }], source: "provider" });
    await runtime.registry.register(adapter, { skipHealth: true });
    expect(reasoningSupportedFor(runtime, "wired-cli")).toBe(true);
  });
});

/**
 * `implicitEffortDefaultFor` — what `--effort` implicitly resolves to when
 * the caller passes no flag AND `config.defaultEffort` is still sitting at
 * its own baked-in "off" default (see `applyEffort` in commands.ts for
 * exactly where this is consulted, and why it is scoped by TRANSPORT rather
 * than a single global value).
 */
describe("implicitEffortDefaultFor — a sensible default without silently overriding a provider's own config", () => {
  function adapterWith(id: string, transport: TransportKind, reasoning: boolean): ProviderAdapter {
    return {
      id,
      label: id,
      transport,
      capabilities: async () => ({
        models: [],
        streaming: true,
        tools: false,
        parallelToolCalls: false,
        vision: false,
        structuredOutput: false,
        reasoning,
        systemPrompt: true,
        fileEdit: false,
        shellExec: false,
        git: false,
        approvalGate: false,
        mcp: false,
        cancel: "abort-signal",
      }),
      chat: async () => {
        throw new Error("unused");
      },
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("unused");
      },
    };
  }

  it("\"medium\" for an http-sdk reasoning-capable provider (anthropic/gemini/vertex/bedrock's family) — nothing else decides this, so NexusCode does", async () => {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    await runtime.registry.register(adapterWith("thinky", "http-sdk", true), { skipHealth: true });
    expect(implicitEffortDefaultFor(runtime, "thinky")).toBe("medium");
  });

  it("\"off\" for a cli-subprocess provider EVEN WHEN it wires reasoning — claude-code/codex already have their own configured effort, never silently overridden", async () => {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    const adapter = adapterWith("wired-cli", "cli-subprocess", true);
    adapter.listReasoningLevels = async () => ({ levels: [{ id: "xhigh" }], source: "provider" });
    await runtime.registry.register(adapter, { skipHealth: true });
    expect(implicitEffortDefaultFor(runtime, "wired-cli")).toBe("off");
  });

  it("\"off\" for an http-openai-compat provider — the shared transport never puts effort on the wire unless it opts in", async () => {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    await runtime.registry.register(adapterWith("deepseek-like", "http-openai-compat", true), { skipHealth: true });
    expect(implicitEffortDefaultFor(runtime, "deepseek-like")).toBe("off");
  });

  it("\"off\" when the provider does not declare reasoning at all (mock)", async () => {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    expect(implicitEffortDefaultFor(runtime, "mock")).toBe("off");
  });

  it("\"off\" for an unknown provider id (never throws)", async () => {
    const config = NexusConfig.parse({ defaultProvider: "mock" });
    const runtime = await buildRuntime(config, { secrets: stubSecrets });
    expect(implicitEffortDefaultFor(runtime, "does-not-exist")).toBe("off");
  });
});
