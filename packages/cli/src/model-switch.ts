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
import type { ProviderCircuitStatus, ProviderCircuitTarget } from "@nexuscode/core";
import type { Runtime } from "@nexuscode/runtime";
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

/** Whether `providerId` advertises reasoning support (drives the `/effort` picker). */
export function reasoningSupportedFor(runtime: Runtime, providerId: string): boolean {
  try {
    return runtime.registry.capabilitiesOf(providerId).reasoning === true;
  } catch {
    return false;
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
}

function accept(
  ctx: SwitchContext,
  provider: string,
  model: string,
  detail: string,
): SwitchResult {
  return {
    accepted: true,
    provider,
    model,
    contextMax: contextWindowFor(ctx.runtime, provider, model, ctx.catalog),
    reasoningSupported: reasoningSupportedFor(ctx.runtime, provider),
    receipt: `${ctx.from.provider}/${ctx.from.model} → ${provider}/${model}; ${detail}`,
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
  return accept(ctx, target, model, "capability and availability preflight passed");
}

/** Preflight a `/provider` pick, landing on a model that provider really has. */
export function preflightProviderSwitch(ctx: SwitchContext, provider: string): SwitchResult {
  if (!isProviderUsable(ctx.runtime, provider)) {
    return { accepted: false, provider, reason: `${provider} is unavailable` };
  }
  const model = resolveSwitchModel(ctx.runtime, provider, ctx.config, ctx.catalog);
  const blocked = circuitBlockedReason(provider, model, ctx.circuit, ctx.circuitTargetFor);
  if (blocked) return { accepted: false, provider, reason: blocked };
  return accept(ctx, provider, model, "model, context and circuit state updated atomically");
}
