/**
 * Provider/model switch preflight for the interactive TUI (`/model`, `/provider`).
 *
 * This used to live inline inside `cmdTui`, where it could not be tested — and it
 * was wrong in a way no test could catch: the `/model` picker is populated from
 * the provider's LIVE model list (`adapter.listModels()`, i.e. the real
 * `/v1/models` catalog), while the preflight validated the user's pick against
 * the CURATED `capabilities().models` snapshot. Those two sets barely overlap
 * (Anthropic's curated ids are undated aliases like `claude-sonnet-4-5`; the live
 * endpoint returns dated ids like `claude-sonnet-4-5-20250929`), so nearly every
 * model a user could actually SEE in the picker was rejected with "provider does
 * not advertise model …" and the switch silently did nothing.
 *
 * The fix is to keep the picker and the preflight on ONE source of truth: the
 * catalog records exactly what the picker offered for each provider, and a pick
 * is valid when it was offered OR is advertised in the curated capabilities. The
 * same catalog also carries each model's real context window, so the HUD gauge
 * reflects the model that was actually picked.
 */

import type { NexusConfig } from "@nexuscode/config";
import {
  assessSwitchTarget,
  inferSwitchRequirements,
  type ProviderCircuitStatus,
  type ProviderCircuitTarget,
  type ProviderSwitchAssessment,
} from "@nexuscode/core";
import type { Runtime } from "@nexuscode/runtime";
import type { ChatRequest, EffortListResult, Message, ToolDef } from "@nexuscode/shared";
import { isProviderUsable, type ProviderModelChoice } from "./runtime.js";

/**
 * Context window assumed when neither the picker nor the provider's capabilities
 * report one. Deliberately a neutral constant: the previous code fell back to
 * `capabilities().models[0]`, which silently reported a DIFFERENT model's window
 * for any model missing from the curated snapshot.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** The outcome of a `/model` or `/provider` switch preflight. */
export type SwitchResult =
  | {
      accepted: true;
      provider: string;
      model: string;
      contextMax: number;
      reasoningSupported: boolean;
      receipt: string;
    }
  | { accepted: false; provider: string; reason: string };

/** The circuit surface the preflight needs (structural, so tests can fake it). */
export interface SwitchCircuit {
  status(target: ProviderCircuitTarget): ProviderCircuitStatus;
}

/**
 * The models the `/model` picker actually OFFERED, per provider — recorded as the
 * picker loads them so the preflight can accept anything the user could see.
 */
export class ModelCatalog {
  private readonly byProvider = new Map<string, Map<string, ProviderModelChoice>>();

  /** Record the rows the picker just showed for `providerId` (replaces prior). */
  record(providerId: string, rows: readonly ProviderModelChoice[]): void {
    this.byProvider.set(providerId, new Map(rows.map((r) => [r.model, r])));
  }

  /** True when `model` was offered for `providerId`. */
  has(providerId: string, model: string): boolean {
    return this.byProvider.get(providerId)?.has(model) === true;
  }

  /** The offered model's real context window, when the provider reported one. */
  contextWindowOf(providerId: string, model: string): number | undefined {
    return this.byProvider.get(providerId)?.get(model)?.contextWindow;
  }

  /** The first model offered for `providerId`, if the picker has loaded it. */
  first(providerId: string): string | undefined {
    const [firstKey] = this.byProvider.get(providerId)?.keys() ?? [];
    return firstKey;
  }
}

/** The curated `capabilities().models` entry matching `model` by id or alias. */
function curatedModel(
  runtime: Runtime,
  providerId: string,
  model: string,
): { id: string; contextWindow?: number } | undefined {
  try {
    return runtime.registry
      .capabilitiesOf(providerId)
      .models.find((m) => m.id === model || m.aliases?.includes(model));
  } catch {
    return undefined;
  }
}

/**
 * Reserve held back from a model's context window when sizing the conversation
 * history budget: room for the answer itself, plus the system prompt, tool
 * definitions and retrieved context that share the same window. History gets the
 * remaining share rather than the whole window.
 */
const OUTPUT_RESERVE_TOKENS = 8_192;
const HISTORY_SHARE = 0.7;
/** Never squeeze history below this, however small the model's window is. */
const MIN_HISTORY_TOKENS = 8_000;

/**
 * How many tokens of conversation history a provider/model can actually afford.
 *
 * The engine's default is a flat 32k ceiling picked when the session opens. On a
 * 1M-token model that discards ~97% of the usable window; on a small model it
 * overflows. Deriving it from the ACTIVE model — and re-reading it every turn —
 * is what makes a switch keep as much of the conversation as the new model can
 * hold, and trim it BEFORE the request when the new model is smaller.
 */
export function historyBudgetFor(
  runtime: Runtime,
  providerId: string,
  model: string,
  catalog?: ModelCatalog,
): number {
  const window = contextWindowFor(runtime, providerId, model, catalog);
  const usable = Math.floor((window - OUTPUT_RESERVE_TOKENS) * HISTORY_SHARE);
  return Math.max(MIN_HISTORY_TOKENS, usable);
}

/**
 * Whether `providerId` actually honors a reasoning EFFORT/budget on the
 * request — drives both the TUI's `/effort` picker (live vs. dead) and the
 * headless `--effort` flag's accept-vs-warn decision (`packages/cli/src/
 * commands.ts`'s `applyEffort`), so the two surfaces can never disagree about
 * which providers this actually works on.
 *
 * `capabilities().reasoning` alone is NOT sufficient: it only promises the
 * provider can PRODUCE reasoning output, and two transport families advertise
 * that without accepting reasoning as an INPUT at all:
 *   - `cli-subprocess` (codex, claude-code): the wrapped CLI runs its own
 *     agent loop; `ChatRequest.reasoning` is never forwarded into its argv —
 *     see each provider's `buildArgs` (no `--reasoning`/`-c
 *     model_reasoning_effort=…` is ever emitted).
 *   - `http-openai-compat` (deepseek, grok, groq, together, mistral, …): the
 *     shared transport only puts `reasoning_effort` on the wire when its
 *     config opts in via `supportsReasoningEffort` (native "openai" and
 *     "azure-openai" do; no compat spec does today — DeepSeek declares
 *     `capabilities.reasoning: true` for its `deepseek-reasoner` MODEL, which
 *     is a model choice, not a per-request effort knob).
 * Without this check both cases would show a live-looking `/effort` picker —
 * or silently accept `--effort` — whose value is dropped before it ever
 * reaches the provider: the same "shown but not real" bug class already fixed
 * once for the command preview.
 */
export function reasoningSupportedFor(runtime: Runtime, providerId: string): boolean {
  try {
    if (runtime.registry.capabilitiesOf(providerId).reasoning !== true) return false;
    const adapter = runtime.registry.get(providerId);
    if (adapter.transport === "cli-subprocess") {
      // A wrapped coding CLI supports reasoning effort as request INPUT only
      // when its adapter actually wires one into its own argv — claude-code's
      // `--effort`, codex's `-c model_reasoning_effort=…` (see each
      // provider's `buildArgs`). That is exactly what implementing
      // `listReasoningLevels` signals (see `@nexuscode/core`'s
      // `ProviderAdapter` doc): asking the adapter structurally, never
      // guessing from `id`/`kind`, is what keeps a FUTURE subprocess CLI with
      // no such wiring `false` here automatically, the same "ask the
      // adapter, never assume" discipline `listModels`/`listModelsWithSource`
      // already established.
      return typeof adapter.listReasoningLevels === "function";
    }
    return adapter.transport !== "http-openai-compat";
  } catch {
    return false;
  }
}

/**
 * The effort value implicitly in force when the caller passes NO explicit
 * `--effort` flag (or `/effort` picker choice) — `applyEffort` consults this
 * only when nothing explicit was given AND `config.defaultEffort` is still
 * sitting at ITS OWN baked-in default ("off"), never when the user actually
 * typed `--effort off` or configured a real non-"off" default (see
 * `applyEffort`'s doc for exactly where this is consulted).
 *
 * Deliberately scoped by TRANSPORT, not a single global value — this is the
 * fix for the reported bug ("Anthropic API: reasoning traces button has
 * nothing to show because nothing sets `thinking` since the effort flag was
 * removed") without reintroducing the DIFFERENT bug that removal was
 * over-correcting for in the first place:
 *   - `http-sdk` (anthropic/gemini/vertex/bedrock's native token-budget
 *     family): nothing else on the machine decides whether extended
 *     thinking runs for these — NexusCode is the only caller of this API, so
 *     it picks a sensible default (`"medium"`) rather than silently sending
 *     none at all.
 *   - `cli-subprocess` (claude-code, codex): the wrapped CLI already has ITS
 *     OWN persistent effort setting the user configures DIRECTLY in that
 *     tool (claude's own `--effort`/`/effort` session state, codex's
 *     `~/.codex/config.toml` `model_reasoning_effort` — confirmed live:
 *     `xhigh` was already configured there). Silently overriding that with
 *     NexusCode's own opinion by default is the EXACT harm the app's
 *     `EffortPicker` was removed over ("sending --effort would silently
 *     override a value they deliberately set") — so these stay implicitly
 *     "off" (send nothing) unless the user explicitly asks with
 *     `--effort <value>` on THIS run.
 *   - anything else (mock, an `openai-compat` backend with no native effort
 *     param): "off" — there is nothing here to default.
 */
export function implicitEffortDefaultFor(runtime: Runtime, providerId: string): string {
  const DEFAULT_IMPLICIT_EFFORT = "medium";
  try {
    if (runtime.registry.capabilitiesOf(providerId).reasoning !== true) return "off";
    const adapter = runtime.registry.get(providerId);
    if (adapter.transport === "cli-subprocess" || adapter.transport === "http-openai-compat") return "off";
    return DEFAULT_IMPLICIT_EFFORT;
  } catch {
    return "off";
  }
}

/**
 * Reasoning-effort level → extended-thinking token budget, in tokens. This is
 * the ONE mapping `reasoningParamsFor` (`packages/cli/src/commands.ts`) uses to
 * build the request AND `reasoningCapabilityFor` (below) uses to describe it on
 * the wire — so a client-visible "24k thinking tokens" label can never drift
 * from the number a `token-budget` provider actually receives. Values are
 * pinned by `packages/cli/test/effort-wire.test.ts`'s "reaches the outgoing
 * ChatRequest" assertions; change them there first.
 */
export const EFFORT_BUDGET_TOKENS: Record<"low" | "medium" | "high", number> = {
  low: 4000,
  medium: 10000,
  high: 24000,
};

/**
 * How a `reasoningSupportedFor`-true provider actually consumes the shared
 * `{ effort, budgetTokens }` pair `reasoningParamsFor` attaches to every
 * request (see its doc comment: BOTH fields are always sent; each adapter
 * family reads only the one it understands):
 *   - `"token-budget"`: the adapter reads `budgetTokens` and ignores `effort`
 *     (Anthropic's `thinking.budget_tokens`, mirrored by Gemini/Vertex's
 *     `thinkingBudget`, and by Bedrock's `additionalModelRequestFields.thinking`
 *     for the Claude models it fronts — see the bedrock adapter's own guard).
 *   - `"effort-string"`: the adapter reads `effort` verbatim and ignores
 *     `budgetTokens` (OpenAI's/Azure OpenAI's native `reasoning_effort` field).
 *   - `"cli-native"`: a wrapped coding CLI (claude-code, codex) with its OWN
 *     live-probed effort vocabulary — see {@link listEffortLevelsFor}. Never
 *     carries a `levels` table here (that would mean spawning the CLI on
 *     every `providers status` call, which this command deliberately never
 *     does — see `cmdProviders`'s own doc comment); a client that needs the
 *     real per-provider scale calls `nexus effort <provider>` instead, the
 *     dedicated "ask on purpose" surface `nexus models <provider>` already
 *     established for live model discovery.
 */
export type ReasoningCapabilityKind = "token-budget" | "effort-string" | "cli-native";

/** `ProviderStatus.kind` values (see `@nexuscode/runtime`) known to read the
 *  shared reasoning params as a raw token budget. */
const TOKEN_BUDGET_KINDS = new Set(["anthropic", "gemini", "vertex", "bedrock"]);

/** `ProviderStatus.kind` values known to read the shared reasoning params as a
 *  native effort string. `@nexuscode/provider-openai`'s native `"openai"`
 *  adapter (`createOpenAIAdapter`) is this same family but is never registered
 *  by `@nexuscode/runtime` today (only its `openai-compat` transport is, via
 *  `createOpenAICompatAdapter`, which does NOT opt into `supportsReasoningEffort`
 *  and so never satisfies `reasoningSupportedFor` in the first place) — so it
 *  never reaches this classification in a real `providers status` today. */
const EFFORT_STRING_KINDS = new Set(["azure"]);

/** The reasoning-effort capability reported on the wire for one provider. */
export interface ReasoningCapability {
  /** Mirrors `reasoningSupportedFor` exactly — the ONE gate every surface
   *  (TUI `/effort` picker, headless `--effort` flag, this field) shares. */
  supported: boolean;
  /** Omitted when unsupported, or when `supported` but the provider's `kind`
   *  is not one of the families above — never guessed. */
  kind?: ReasoningCapabilityKind;
  /**
   * The concrete token budget per level, present only for `kind:
   * "token-budget"` — exactly what `reasoningParamsFor` puts on the wire, so a
   * client can render e.g. "High — 24k thinking tokens" truthfully. A
   * `kind: "effort-string"` provider needs no such table: the level name IS
   * the value sent (`reasoning_effort: "high"`).
   */
  levels?: Record<"low" | "medium" | "high", number>;
}

/**
 * The reasoning-effort capability `providers status -o json` reports for
 * `providerId` — the answer to "the thinking-effort control's names must
 * change based on provider": a client that only sees `reasoningSupported`
 * cannot tell a token-budget provider (label the number) from an
 * effort-string one (label the level alone), and previously saw NEITHER, so it
 * rendered a live-looking `Off/Low/Med/High` control for every provider,
 * including ones that silently ignore it (`--effort` for `cli-subprocess`/
 * `http-openai-compat` transports) — the same "shown but not real" class
 * `reasoningSupportedFor` already fixed for the TUI and the headless flag, now
 * closed for the wire contract a client actually reads.
 *
 * Deliberately does NOT re-derive `supported` — it calls
 * {@link reasoningSupportedFor} so this can never drift from the TUI picker or
 * `--effort`'s own gate.
 */
export function reasoningCapabilityFor(runtime: Runtime, providerId: string): ReasoningCapability {
  if (!reasoningSupportedFor(runtime, providerId)) return { supported: false };
  try {
    if (runtime.registry.get(providerId).transport === "cli-subprocess") {
      return { supported: true, kind: "cli-native" };
    }
  } catch {
    return { supported: false };
  }
  const kind = runtime.statuses.find((s) => s.id === providerId)?.kind;
  if (kind !== undefined && TOKEN_BUDGET_KINDS.has(kind)) {
    return { supported: true, kind: "token-budget", levels: { ...EFFORT_BUDGET_TOKENS } };
  }
  if (kind !== undefined && EFFORT_STRING_KINDS.has(kind)) {
    return { supported: true, kind: "effort-string" };
  }
  // `reasoningSupportedFor` says yes but this `kind` isn't one of the mapped
  // families — report the flag honestly without guessing the wire shape.
  return { supported: true };
}

/**
 * Live, per-provider reasoning-effort discovery — the "ask on purpose"
 * surface `cmdProviders`'s own doc comment points to (mirrors `nexus models
 * <provider>` for model discovery). Calls the adapter's own
 * `listReasoningLevels` (present only on claude-code/codex today — see each
 * provider's doc) when it exists; `undefined` means this provider has no
 * live per-provider scale to probe (the token-budget/effort-string family,
 * whose scale is `EFFORT_BUDGET_TOKENS` — NexusCode's own definition, not
 * something to ask the backend for) or the provider is unregistered.
 *
 * Never throws: `listReasoningLevels` itself is contractually non-throwing
 * (see `ProviderAdapter`'s doc), but this still guards a bad/misbehaving
 * adapter from taking down a caller that just wants a picker to populate.
 */
export async function listEffortLevelsFor(
  runtime: Runtime,
  providerId: string,
): Promise<EffortListResult | undefined> {
  try {
    const adapter = runtime.registry.get(providerId);
    if (typeof adapter.listReasoningLevels !== "function") return undefined;
    return await adapter.listReasoningLevels();
  } catch {
    return undefined;
  }
}

/**
 * True when `model` is a legitimate pick for `providerId`: either the picker
 * offered it (the live catalog) or the curated capabilities advertise it. A
 * provider with no model catalog at all (a wrapped coding CLI, which owns its own
 * model selection) accepts any id rather than blocking the user.
 */
export function modelAdvertised(
  runtime: Runtime,
  providerId: string,
  model: string,
  catalog?: ModelCatalog,
): boolean {
  if (catalog?.has(providerId, model)) return true;
  if (curatedModel(runtime, providerId, model)) return true;
  let curatedCount = 0;
  try {
    curatedCount = runtime.registry.capabilitiesOf(providerId).models.length;
  } catch {
    return false;
  }
  // Nothing to validate against (subprocess coding CLIs declare no models and the
  // picker never loaded any) — the vendor CLI validates its own model id.
  return curatedCount === 0 && catalog?.first(providerId) === undefined;
}

/**
 * The real context window for `providerId`/`model`. Prefers what the picker's
 * live catalog reported, then the curated capabilities entry for THAT model, and
 * finally {@link DEFAULT_CONTEXT_WINDOW} — never another model's window.
 */
export function contextWindowFor(
  runtime: Runtime,
  providerId: string,
  model: string,
  catalog?: ModelCatalog,
): number {
  return (
    catalog?.contextWindowOf(providerId, model) ??
    curatedModel(runtime, providerId, model)?.contextWindow ??
    DEFAULT_CONTEXT_WINDOW
  );
}

/**
 * Pick the model to land on when switching TO `providerId`. `config.defaultModel`
 * is a single global setting, so it is honored only when the TARGET provider
 * actually offers it — otherwise switching provider carried the previous
 * provider's model id across (e.g. an Anthropic id onto OpenAI), which the
 * provider-switch path then accepted without any validation and only failed at
 * dispatch time. Falls back to the first model the picker offered, then the first
 * curated model, then `""` (a wrapped coding CLI chooses its own default).
 */
export function resolveSwitchModel(
  runtime: Runtime,
  providerId: string,
  config: NexusConfig,
  catalog?: ModelCatalog,
): string {
  const preferred = config.defaultModel;
  if (preferred !== undefined && preferred.length > 0) {
    if (catalog?.has(providerId, preferred) || curatedModel(runtime, providerId, preferred)) {
      return preferred;
    }
  }
  const offered = catalog?.first(providerId);
  if (offered !== undefined) return offered;
  try {
    return runtime.registry.capabilitiesOf(providerId).models[0]?.id ?? "";
  } catch {
    return "";
  }
}

/** Circuit availability check shared by both switch paths. */
function circuitBlockedReason(
  provider: string,
  model: string,
  circuit: SwitchCircuit | undefined,
  circuitTargetFor: ((candidate: SwitchCandidate) => ProviderCircuitTarget) | undefined,
): string | undefined {
  if (!circuit) return undefined;
  const candidate: SwitchCandidate = { providerId: provider, modelId: model, reason: "explicit" };
  const target = circuitTargetFor?.(candidate) ?? { providerId: provider, modelId: model };
  const status = circuit.status(target);
  if (status.availability !== "blocked") return undefined;
  const until = status.retryAt ? ` until ${new Date(status.retryAt).toLocaleTimeString()}` : "";
  return `${provider}/${model} is unavailable${until}`;
}

/** The shape `circuitTargetFor` expects (a route candidate). */
export interface SwitchCandidate {
  providerId: string;
  modelId: string;
  reason: "explicit";
}

/** Everything both preflights need from the host. */
export interface SwitchContext {
  runtime: Runtime;
  config: NexusConfig;
  catalog: ModelCatalog;
  circuit?: SwitchCircuit | undefined;
  circuitTargetFor?: ((candidate: SwitchCandidate) => ProviderCircuitTarget) | undefined;
  /** The provider/model in effect right now (used for the receipt). */
  from: { provider: string; model: string };
  /**
   * The session's short-term conversation memory AS IT STANDS right now
   * (read-only) — what `assessSwitchTarget` needs to know whether the target
   * can accept what the conversation already contains (tool calls/results,
   * modalities used, …). There is no new turn yet at preflight time (unlike
   * `chat --persistent`'s `{"type":"switch"}` control line, which at least
   * has `session.transcript`), so this IS the probe, not a request built
   * around one. Optional only so a caller with no live session (tests, a
   * future non-conversational host) degrades to the pre-existing
   * usable/advertised/circuit-only preflight rather than being forced to
   * fabricate one.
   */
  transcript?: readonly Message[] | undefined;
  /** The active system prompt, if any — folded into the same probe. */
  system?: string | undefined;
  /** Tools available to the NEXT turn, if any — folded into the same probe. */
  tools?: ToolDef[] | undefined;
}

/**
 * Assess whether `provider`/`model` can accept what this conversation already
 * needs — the same `assessSwitchTarget` check `chat --persistent`'s explicit
 * switch control line runs (`commands.ts`'s `performSwitch`), reused here so
 * the TUI picker inherits every blocker it has, current and future, instead
 * of maintaining a second list that will drift. Capability metadata is
 * advisory: a provider whose capabilities can't be read degrades to `undefined`
 * (skip the check) rather than blocking the switch on a read failure.
 */
function capabilityAssessment(
  ctx: SwitchContext,
  provider: string,
  model: string,
): ProviderSwitchAssessment | undefined {
  if (ctx.transcript === undefined) return undefined;
  let caps;
  try {
    caps = ctx.runtime.registry.capabilitiesOf(provider);
  } catch {
    return undefined;
  }
  const probeRequest: ChatRequest = {
    model,
    messages: [...ctx.transcript],
    ...(ctx.system !== undefined ? { system: ctx.system } : {}),
    ...(ctx.tools ? { tools: ctx.tools } : {}),
  };
  const sourcePrice =
    ctx.runtime.pricing[ctx.from.model] ?? ctx.runtime.pricing[`${ctx.from.provider}/${ctx.from.model}`];
  return assessSwitchTarget(provider, model, caps, inferSwitchRequirements(probeRequest), {
    pricing: ctx.runtime.pricing,
    ...(sourcePrice ? { sourcePrice } : {}),
    ...(ctx.config.switching.maxCostMultiplier !== undefined
      ? { maxCostMultiplier: ctx.config.switching.maxCostMultiplier }
      : {}),
    ...(ctx.config.switching.contextSafetyMarginTokens !== undefined
      ? { contextSafetyMarginTokens: ctx.config.switching.contextSafetyMarginTokens }
      : {}),
  });
}

function accept(
  ctx: SwitchContext,
  provider: string,
  model: string,
  detail: string,
  warnings: readonly string[] = [],
): SwitchResult {
  const fullDetail = warnings.length > 0 ? `${detail}; ${warnings.join("; ")}` : detail;
  return {
    accepted: true,
    provider,
    model,
    contextMax: contextWindowFor(ctx.runtime, provider, model, ctx.catalog),
    reasoningSupported: reasoningSupportedFor(ctx.runtime, provider),
    receipt: `${ctx.from.provider}/${ctx.from.model} → ${provider}/${model}; ${fullDetail}`,
  };
}

/** Preflight a `/model` pick. Never throws — a failure becomes a rejection. */
export function preflightModelSwitch(
  ctx: SwitchContext,
  model: string,
  provider: string,
): SwitchResult {
  const target = provider || ctx.from.provider;
  if (!isProviderUsable(ctx.runtime, target)) {
    return { accepted: false, provider: target, reason: `${target} is unavailable` };
  }
  if (!modelAdvertised(ctx.runtime, target, model, ctx.catalog)) {
    return { accepted: false, provider: target, reason: `${target} has no model ${model}` };
  }
  const blocked = circuitBlockedReason(target, model, ctx.circuit, ctx.circuitTargetFor);
  if (blocked) return { accepted: false, provider: target, reason: blocked };
  const assessment = capabilityAssessment(ctx, target, model);
  if (assessment && !assessment.compatible) {
    return { accepted: false, provider: target, reason: assessment.blockers.join("; ") };
  }
  return accept(
    ctx,
    target,
    model,
    "capability and availability preflight passed",
    assessment?.warnings,
  );
}

/** Preflight a `/provider` pick, landing on a model that provider really has. */
export function preflightProviderSwitch(ctx: SwitchContext, provider: string): SwitchResult {
  if (!isProviderUsable(ctx.runtime, provider)) {
    return { accepted: false, provider, reason: `${provider} is unavailable` };
  }
  const model = resolveSwitchModel(ctx.runtime, provider, ctx.config, ctx.catalog);
  const blocked = circuitBlockedReason(provider, model, ctx.circuit, ctx.circuitTargetFor);
  if (blocked) return { accepted: false, provider, reason: blocked };
  const assessment = capabilityAssessment(ctx, provider, model);
  if (assessment && !assessment.compatible) {
    return { accepted: false, provider, reason: assessment.blockers.join("; ") };
  }
  return accept(
    ctx,
    provider,
    model,
    "model, context and circuit state updated atomically",
    assessment?.warnings,
  );
}
