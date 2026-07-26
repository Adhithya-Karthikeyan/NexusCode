/**
 * CLI binding for persistent provider availability and continuity policies.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  ProviderCircuitBreaker,
  type EngineConfig,
  type ProviderCircuitTarget,
  type RouteCandidate,
} from "@nexuscode/core";
import { nexusPaths, type NexusConfig } from "@nexuscode/config";
import type { TransferRuntime } from "./transfer.js";

export function providerCircuitPath(config: NexusConfig): string {
  return (
    config.providerCircuit.filePath ??
    join(process.env["NEXUS_DATA_DIR"] ?? nexusPaths().data, "provider-circuits.json")
  );
}

export function openProviderCircuit(
  config: NexusConfig,
): ProviderCircuitBreaker | undefined {
  if (!config.providerCircuit.enabled) return undefined;
  return new ProviderCircuitBreaker({
    filePath: providerCircuitPath(config),
    transientFailureThreshold: config.providerCircuit.transientFailureThreshold,
    baseCooldownMs: config.providerCircuit.baseCooldownMs,
    maxCooldownMs: config.providerCircuit.maxCooldownMs,
    quotaCooldownMs: config.providerCircuit.quotaCooldownMs,
    modelUnavailableCooldownMs: config.providerCircuit.modelUnavailableCooldownMs,
    maxClockSkewMs: config.providerCircuit.maxClockSkewMs,
    maxEntries: config.providerCircuit.maxEntries,
  });
}

function providerCredentialIdentity(config: NexusConfig, providerId: string): string {
  const declared = config.providers.find((provider) => provider.id === providerId);
  if (declared) {
    return (
      declared.apiKeyRef ??
      declared.apiKeyEnv ??
      declared.baseUrl ??
      declared.command ??
      declared.id
    );
  }
  if (providerId === "gemini") return config.gemini.apiKeyEnv;
  if (providerId === "bedrock") return process.env["AWS_PROFILE"] ?? "aws-default-chain";
  if (providerId === "vertex") {
    return process.env["GOOGLE_CLOUD_PROJECT"] ?? config.vertex.project ?? "gcp-default-chain";
  }
  return providerId;
}

/** Stable account scope for quota/auth circuits; credential values are never hashed or stored. */
export function circuitTargetMapper(
  config: NexusConfig,
): (candidate: RouteCandidate) => ProviderCircuitTarget {
  return (candidate) => ({
    providerId: candidate.providerId,
    accountId: createHash("sha256")
      .update(`${candidate.providerId}\0${providerCredentialIdentity(config, candidate.providerId)}`)
      .digest("hex")
      .slice(0, 16),
    modelId: candidate.modelId,
  });
}

/** Fields spread into every CLI-created engine. */
export function continuityEngineOptions(
  config: NexusConfig,
  transfer: TransferRuntime,
  providerCircuit = openProviderCircuit(config),
): Pick<
  EngineConfig,
  | "providerCircuit"
  | "circuitTargetFor"
  | "handoffBuilder"
  | "partialRecovery"
  | "switching"
  | "actionGuard"
> {
  const out: Pick<
    EngineConfig,
    | "providerCircuit"
    | "circuitTargetFor"
    | "handoffBuilder"
    | "partialRecovery"
    | "switching"
    | "actionGuard"
  > = {};
  if (providerCircuit) {
    out.providerCircuit = providerCircuit;
    out.circuitTargetFor = circuitTargetMapper(config);
  }
  if (transfer.handoffBuilder) out.handoffBuilder = transfer.handoffBuilder;
  if (transfer.actionGuard) out.actionGuard = transfer.actionGuard;
  if (config.transfer.handoff.partialContinuation.enabled) {
    out.partialRecovery = {
      enabled: true,
      maxPartialContextCodePoints:
        config.transfer.handoff.partialContinuation.maxContextCodePoints,
    };
  }
  out.switching = {
    policy: config.switching.policy,
    maxFallbacks: config.switching.maxFallbacks,
    preferredProviders: config.switching.preferredProviders,
    ...(config.switching.allowProviders.length > 0
      ? { allowProviders: config.switching.allowProviders }
      : {}),
    ...(config.switching.denyProviders.length > 0
      ? { denyProviders: config.switching.denyProviders }
      : {}),
    maxCostMultiplier: config.switching.maxCostMultiplier,
    contextSafetyMarginTokens: config.switching.contextSafetyMarginTokens,
    nativeSessionSlots: config.switching.nativeSessionSlots,
  };
  return out;
}
