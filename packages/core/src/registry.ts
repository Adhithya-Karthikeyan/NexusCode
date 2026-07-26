/**
 * Provider registry + capability negotiation. The router never imports a
 * concrete adapter — it asks the registry `select(c => c.fileEdit)`,
 * `select(c => c.vision)`, or resolves a model alias. That is the structural
 * guarantee behind "core never changes when a provider is added".
 */

import { AdapterError, NexusError, type Capabilities, type ModelInfo } from "@nexuscode/shared";
import type { HealthStatus, ProviderAdapter } from "./adapter.js";

interface RegistryEntry {
  adapter: ProviderAdapter;
  caps: Capabilities;
  health?: HealthStatus;
}

export interface ResolvedModel {
  providerId: string;
  modelId: string;
}

export class ProviderRegistry {
  private readonly byId = new Map<string, RegistryEntry>();

  /**
   * Probe and register an adapter. Throws on duplicate id. Pass
   * `skipHealth: true` to register without running the adapter's health probe —
   * used for credential-less default providers so registration stays fully
   * offline (their reachability is reported as "needs key" instead of probed).
   */
  async register(adapter: ProviderAdapter, opts?: { signal?: AbortSignal; skipHealth?: boolean }): Promise<void> {
    if (this.byId.has(adapter.id)) {
      throw new NexusError("duplicate_provider", `duplicate provider id: ${adapter.id}`);
    }
    const caps = await adapter.capabilities(opts?.signal ? { signal: opts.signal } : undefined);
    const entry: RegistryEntry = { adapter, caps };
    if (adapter.health && opts?.skipHealth !== true) {
      const signal = opts?.signal ?? new AbortController().signal;
      const health = await adapter.health({
        signal,
        idempotencyKey: `health:${adapter.id}`,
        traceId: `health:${adapter.id}`,
        runId: `health:${adapter.id}`,
      });
      entry.health = health;
    }
    this.byId.set(adapter.id, entry);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  /** Resolve an adapter by id; throws `AdapterError("invalid_request")` if absent. */
  get(id: string): ProviderAdapter {
    const entry = this.byId.get(id);
    if (!entry) throw new AdapterError("invalid_request", `no provider "${id}"`);
    return entry.adapter;
  }

  capabilitiesOf(id: string): Capabilities {
    const entry = this.byId.get(id);
    if (!entry) throw new AdapterError("invalid_request", `no provider "${id}"`);
    return entry.caps;
  }

  /**
   * Fold a provider's REAL model list (from `adapter.listModels()`) into its
   * capabilities.
   *
   * `capabilities().models` is a curated snapshot — for Anthropic it is a handful
   * of undated aliases, while the live `/v1/models` endpoint returns the dated
   * ids a user actually picks. Every consumer that asks "does this provider have
   * this model?" reads `capabilitiesOf`, so without this merge a live-discovered
   * model is treated as unknown everywhere: the switch preflight rejects it, the
   * HUD cannot size its context window, and — most damagingly —
   * `assessSwitchTarget` marks it incompatible, which silently skips the
   * context-window compaction that makes a switch safe.
   *
   * Discovered models are APPENDED after the curated ones and de-duplicated by
   * id, so `models[0]` (the default-model pick) never changes. Idempotent: the
   * same list can be recorded on every picker open. Unknown providers are
   * ignored rather than throwing — discovery is best-effort.
   */
  recordDiscoveredModels(id: string, models: readonly ModelInfo[]): void {
    const entry = this.byId.get(id);
    if (!entry || models.length === 0) return;
    const byModelId = new Map(entry.caps.models.map((m) => [m.id, m]));
    let added = false;
    for (const model of models) {
      if (!model.id) continue;
      const existing = byModelId.get(model.id);
      if (existing === undefined) {
        byModelId.set(model.id, model);
        added = true;
        continue;
      }
      // Keep the curated entry (config-driven pricing/aliases win) but adopt
      // facts discovery knows and the snapshot does not.
      if (existing.contextWindow === undefined && model.contextWindow !== undefined) {
        byModelId.set(model.id, { ...existing, contextWindow: model.contextWindow });
        added = true;
      }
    }
    if (!added) return;
    const curatedIds = new Set(entry.caps.models.map((m) => m.id));
    const merged = [
      ...entry.caps.models.map((m) => byModelId.get(m.id) ?? m),
      ...[...byModelId.values()].filter((m) => !curatedIds.has(m.id)),
    ];
    entry.caps = { ...entry.caps, models: merged };
  }

  healthOf(id: string): HealthStatus | undefined {
    return this.byId.get(id)?.health;
  }

  /**
   * Record an offline availability result discovered by the runtime (missing
   * credential/binary, without probing the network).
   */
  setHealth(id: string, health: HealthStatus): void {
    const entry = this.byId.get(id);
    if (!entry) throw new AdapterError("invalid_request", `no provider "${id}"`);
    entry.health = { ...health };
  }

  /** All adapters whose capabilities satisfy the predicate. */
  select(pred: (c: Capabilities) => boolean): ProviderAdapter[] {
    const out: ProviderAdapter[] = [];
    for (const entry of this.byId.values()) if (pred(entry.caps)) out.push(entry.adapter);
    return out;
  }

  /** Map a model alias/native id to its owning provider + native id. */
  resolveModel(alias: string): ResolvedModel | undefined {
    for (const [providerId, entry] of this.byId) {
      const m = entry.caps.models.find((mi) => mi.id === alias || mi.aliases?.includes(alias));
      if (m) return { providerId, modelId: m.id };
    }
    return undefined;
  }

  list(): RegistryEntry[] {
    return [...this.byId.values()];
  }

  ids(): string[] {
    return [...this.byId.keys()];
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.byId.values()].map((e) => e.adapter.dispose?.()));
    this.byId.clear();
  }
}
