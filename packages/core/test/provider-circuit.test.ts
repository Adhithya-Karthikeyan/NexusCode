import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AdapterError,
  ProviderCircuitBreaker,
  classifyProviderCircuitFailure,
  providerCircuitKey,
  type ProviderCircuitTarget,
} from "@nexuscode/core";

function clockAt(start: number): { now: () => number; set: (value: number) => void } {
  let current = start;
  return {
    now: () => current,
    set: (value) => {
      current = value;
    },
  };
}

const TARGET: ProviderCircuitTarget = {
  providerId: "openai",
  accountId: "team-a",
  modelId: "gpt-test",
};

describe("ProviderCircuitBreaker", () => {
  let directory: string;
  let filePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "nexus-provider-circuit-"));
    filePath = join(directory, "state", "circuits.json");
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("persists quota state atomically with private permissions and reloads it", () => {
    const clock = clockAt(1_000);
    const breaker = new ProviderCircuitBreaker({ filePath, now: clock.now });
    const error = new AdapterError("quota_exhausted", "insufficient quota api_key=secret", {
      providerId: "openai",
      retryAfterMs: 5_000,
    });

    const opened = breaker.recordFailure(TARGET, error, {
      resetAt: 6_000,
      annotations: { quotaRemaining: 0, quotaUnit: "tokens" },
    });

    expect(opened).toMatchObject({
      state: "open",
      availability: "blocked",
      reason: "quota",
      blockedUntil: 6_000,
      target: { providerId: "openai", accountId: "team-a" },
      annotations: { quotaRemaining: 0, quotaUnit: "tokens", quotaResetAt: 6_000 },
    });
    expect(opened.target.modelId).toBeUndefined();
    expect(opened.lastError?.message).toContain("[REDACTED]");
    expect(statSync(filePath).mode & 0o777).toBe(0o600);

    clock.set(2_000);
    const reloaded = new ProviderCircuitBreaker({ filePath, now: clock.now });
    expect(reloaded.loadIssue).toBeUndefined();
    expect(reloaded.status({ ...TARGET, modelId: "gpt-other" })).toMatchObject({
      state: "open",
      reason: "quota",
      blockedUntil: 6_000,
    });
  });

  it("opens transient circuits at the threshold and exponentially backs off failed probes", () => {
    const clock = clockAt(1_000);
    const breaker = new ProviderCircuitBreaker({
      now: clock.now,
      transientFailureThreshold: 2,
      baseCooldownMs: 100,
      maxCooldownMs: 400,
    });
    const error = new AdapterError("transport", "connection reset");

    expect(breaker.recordFailure(TARGET, error)).toMatchObject({
      state: "closed",
      attempts: 1,
      reason: "transient",
    });
    expect(breaker.tryAcquire(TARGET).allowed).toBe(true);

    expect(breaker.recordFailure(TARGET, error)).toMatchObject({
      state: "open",
      attempts: 2,
      openCount: 1,
      blockedUntil: 1_100,
    });
    expect(breaker.tryAcquire(TARGET)).toMatchObject({
      allowed: false,
      retryAfterMs: 100,
    });

    clock.set(1_100);
    const probe = breaker.tryAcquire(TARGET);
    expect(probe).toMatchObject({ allowed: true, probe: true });
    expect(breaker.tryAcquire(TARGET)).toMatchObject({
      allowed: false,
      status: { state: "half-open", availability: "probing" },
    });
    if (!probe.allowed || !probe.lease) throw new Error("expected a half-open lease");

    expect(breaker.recordFailure(TARGET, error, { lease: probe.lease })).toMatchObject({
      state: "open",
      openCount: 2,
      blockedUntil: 1_300,
    });
  });

  it("admits one half-open probe and fully recovers after its success", () => {
    const clock = clockAt(10_000);
    const breaker = new ProviderCircuitBreaker({
      now: clock.now,
      transientFailureThreshold: 1,
      baseCooldownMs: 50,
    });
    breaker.recordFailure(TARGET, new AdapterError("overloaded", "busy"));
    clock.set(10_050);

    const first = breaker.tryAcquire(TARGET);
    const second = breaker.tryAcquire(TARGET);
    expect(first).toMatchObject({ allowed: true, probe: true });
    expect(second).toMatchObject({ allowed: false, probe: false });
    if (!first.allowed || !first.lease) throw new Error("expected a half-open lease");

    expect(breaker.recordSuccess(TARGET, first.lease)).toMatchObject({
      state: "closed",
      availability: "available",
      attempts: 0,
      openCount: 0,
      lastSuccessAt: 10_050,
    });
    expect(breaker.tryAcquire(TARGET)).toMatchObject({ allowed: true, probe: false });
  });

  it("admits only one half-open probe across independent processes sharing a store", () => {
    const clock = clockAt(20_000);
    const firstProcess = new ProviderCircuitBreaker({
      filePath,
      now: clock.now,
      transientFailureThreshold: 1,
      baseCooldownMs: 50,
    });
    const secondProcess = new ProviderCircuitBreaker({
      filePath,
      now: clock.now,
      transientFailureThreshold: 1,
      baseCooldownMs: 50,
    });
    firstProcess.recordFailure(TARGET, new AdapterError("overloaded", "busy"));
    clock.set(20_050);

    const first = firstProcess.tryAcquire(TARGET);
    const second = secondProcess.tryAcquire(TARGET);
    expect(first).toMatchObject({ allowed: true, probe: true });
    expect(second).toMatchObject({
      allowed: false,
      status: { state: "half-open", availability: "probing" },
    });
  });

  it("merges sequential updates from independent processes instead of losing entries", () => {
    const firstProcess = new ProviderCircuitBreaker({ filePath, now: () => 1_000 });
    const secondProcess = new ProviderCircuitBreaker({ filePath, now: () => 1_000 });
    firstProcess.recordFailure(TARGET, new AdapterError("quota_exhausted", "limit reached"));
    secondProcess.recordFailure(
      { ...TARGET, accountId: "team-b" },
      new AdapterError("quota_exhausted", "limit reached"),
    );

    const reloaded = new ProviderCircuitBreaker({ filePath, now: () => 1_001 });
    expect(reloaded.listStatuses()).toHaveLength(2);
  });

  it("honors Retry-After immediately even below the transient threshold", () => {
    const clock = clockAt(5_000);
    const breaker = new ProviderCircuitBreaker({
      now: clock.now,
      transientFailureThreshold: 10,
    });
    const status = breaker.recordFailure(
      TARGET,
      new AdapterError("rate_limit", "slow down", { retryAfterMs: 2_500 }),
    );
    expect(status).toMatchObject({
      state: "open",
      reason: "transient",
      blockedUntil: 7_500,
    });
  });

  it("isolates account-wide quota and model-specific availability failures", () => {
    const clock = clockAt(1_000);
    const breaker = new ProviderCircuitBreaker({ now: clock.now, quotaCooldownMs: 1_000 });

    breaker.recordFailure(TARGET, new AdapterError("quota_exhausted", "usage limit reached"));
    expect(breaker.status({ ...TARGET, modelId: "gpt-other" }).reason).toBe("quota");
    expect(
      breaker.status({ providerId: "openai", accountId: "team-b", modelId: "gpt-test" }).state,
    ).toBe("closed");

    breaker.reset({ providerId: "openai", accountId: "team-a" });
    breaker.recordFailure(
      TARGET,
      new AdapterError("invalid_request", "model gpt-test is unavailable"),
    );
    expect(breaker.status(TARGET)).toMatchObject({
      state: "open",
      reason: "model_unavailable",
      target: TARGET,
    });
    expect(breaker.status({ ...TARGET, modelId: "gpt-other" }).state).toBe("closed");
  });

  it("keeps auth failures blocked until a manual reset", () => {
    const clock = clockAt(1_000);
    const breaker = new ProviderCircuitBreaker({ now: clock.now });
    const opened = breaker.recordFailure(
      TARGET,
      new AdapterError("auth", "invalid API key"),
    );
    expect(opened).toMatchObject({ state: "open", reason: "auth" });
    expect(opened.blockedUntil).toBeUndefined();

    clock.set(10_000_000);
    expect(breaker.tryAcquire(TARGET).allowed).toBe(false);
    expect(breaker.reset({ providerId: "openai", accountId: "team-a" })).toBe(1);
    expect(breaker.tryAcquire(TARGET).allowed).toBe(true);
  });

  it("resets provider/account descendants without touching isolated accounts", () => {
    const breaker = new ProviderCircuitBreaker({ now: () => 1_000 });
    breaker.recordFailure(TARGET, new AdapterError("invalid_request", "model gpt-test unavailable"));
    breaker.recordFailure(
      { providerId: "openai", accountId: "team-a", modelId: "gpt-other" },
      new AdapterError("invalid_request", "model gpt-other unavailable"),
    );
    breaker.recordFailure(
      { providerId: "openai", accountId: "team-b", modelId: "gpt-test" },
      new AdapterError("invalid_request", "model gpt-test unavailable"),
    );

    expect(breaker.listStatuses()).toHaveLength(3);
    expect(breaker.reset({ providerId: "openai", accountId: "team-a" })).toBe(2);
    expect(breaker.listStatuses()).toHaveLength(1);
    expect(breaker.listStatuses()[0]?.target.accountId).toBe("team-b");
  });

  it("exposes availability and cost/quota annotations for provider status UIs", () => {
    const breaker = new ProviderCircuitBreaker({ filePath, now: () => 1_000 });
    const status = breaker.annotate(TARGET, {
      estimatedRequestCostUsd: 0.012,
      quotaRemaining: 90,
      quotaUnit: "percent",
      quotaResetAt: 50_000,
      statusLabel: "Ready",
      details: { region: "us-east-1" },
    });
    expect(status).toMatchObject({
      state: "closed",
      availability: "available",
      annotations: {
        estimatedRequestCostUsd: 0.012,
        quotaRemaining: 90,
        quotaResetAt: 50_000,
        statusLabel: "Ready",
      },
    });
    expect(new ProviderCircuitBreaker({ filePath, now: () => 2_000 }).status(TARGET)).toMatchObject({
      annotations: { estimatedRequestCostUsd: 0.012, quotaRemaining: 90 },
    });
  });

  it("ignores request-specific errors instead of poisoning provider availability", () => {
    const breaker = new ProviderCircuitBreaker({ now: () => 1_000 });
    expect(classifyProviderCircuitFailure(new AdapterError("context_length", "too long"))).toBeUndefined();
    expect(classifyProviderCircuitFailure(new AdapterError("cancelled", "user cancelled"))).toBeUndefined();
    expect(breaker.recordFailure(TARGET, new AdapterError("content_filter", "blocked"))).toMatchObject({
      state: "closed",
      attempts: 0,
    });
  });

  it("tolerates corrupt/unknown JSON and replaces it on the next state change", () => {
    mkdirSync(join(directory, "state"), { recursive: true });
    writeFileSync(filePath, "{ definitely not json", "utf8");
    const breaker = new ProviderCircuitBreaker({ filePath, now: () => 1_000 });

    expect(breaker.loadIssue).toBeInstanceOf(Error);
    expect(breaker.tryAcquire(TARGET).allowed).toBe(true);
    breaker.recordFailure(TARGET, new AdapterError("quota_exhausted", "quota exceeded"));
    expect(JSON.parse(readFileSync(filePath, "utf8"))).toMatchObject({ version: 1 });

    writeFileSync(filePath, JSON.stringify({ version: 999, savedAt: 1_000, entries: [] }), "utf8");
    const unknownVersion = new ProviderCircuitBreaker({ filePath, now: () => 1_000 });
    expect(unknownVersion.loadIssue?.message).toContain("unsupported");
    expect(unknownVersion.listStatuses()).toEqual([]);
  });

  it("rebases cooldowns on backward clock correction and expires them on forward jumps", () => {
    const firstClock = clockAt(10_000);
    const first = new ProviderCircuitBreaker({ filePath, now: firstClock.now });
    first.recordFailure(TARGET, new AdapterError("quota_exhausted", "quota exceeded"), {
      retryAt: 11_000,
    });

    const correctedClock = clockAt(1_000);
    const reloaded = new ProviderCircuitBreaker({
      filePath,
      now: correctedClock.now,
      maxClockSkewMs: 10,
    });
    expect(reloaded.status(TARGET).blockedUntil).toBe(2_000);
    correctedClock.set(2_000);
    expect(reloaded.status(TARGET)).toMatchObject({
      state: "half-open",
      availability: "probe_available",
    });

    reloaded.reset();
    correctedClock.set(5_000);
    reloaded.recordFailure(TARGET, new AdapterError("quota_exhausted", "quota exceeded"), {
      retryAt: 6_000,
    });
    correctedClock.set(1_000);
    expect(reloaded.status(TARGET).blockedUntil).toBe(2_000);
    correctedClock.set(1_000_000);
    expect(reloaded.status(TARGET).state).toBe("half-open");
  });

  it("creates collision-safe keys for provider/account/model scopes", () => {
    expect(providerCircuitKey({ providerId: "a/b", accountId: "x|y", modelId: "m:n" })).toBe(
      "p:a%2Fb|a:x%7Cy|m:m%3An",
    );
    expect(() => providerCircuitKey({ providerId: "  " })).toThrow(/providerId/);
  });
});
