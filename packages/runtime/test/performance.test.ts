/**
 * Performance wiring in the runtime bootstrap (system-spec §23, Wave 12):
 *   - the `performance.pool` config is applied process-wide via `configureHttpPool`
 *     BEFORE any adapter is constructed, so every HTTP provider shares the
 *     configured keep-alive pool;
 *   - `performance.lazy` decides whether registered heavy subsystems are deferred
 *     (default) or eagerly constructed at bootstrap.
 * Fully offline: only the mock provider is exercised and the pool is reset after.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { NexusConfig, type SecretStore } from "@nexuscode/config";
import { httpPoolOptions, resetHttpPool } from "@nexuscode/shared";
import { buildRuntime } from "../src/index.js";

const stubSecrets: SecretStore = {
  get: async () => null,
  set: async () => {},
  delete: async () => {},
  source: async () => null,
};

afterEach(() => {
  resetHttpPool();
});

describe("runtime performance wiring", () => {
  it("applies the configured connection-pool tuning process-wide", async () => {
    const config = NexusConfig.parse({
      performance: { pool: { maxSockets: 7, maxFreeSockets: 3, keepAliveMsecs: 250 } },
    });
    await buildRuntime(config, { secrets: stubSecrets });
    const pool = httpPoolOptions();
    expect(pool.maxSockets).toBe(7);
    expect(pool.maxFreeSockets).toBe(3);
    expect(pool.keepAliveMsecs).toBe(250);
  });

  it("defaults reproduce the pre-Wave-12 pool sizes", async () => {
    await buildRuntime(NexusConfig.parse({}), { secrets: stubSecrets });
    expect(httpPoolOptions()).toEqual({ maxSockets: 64, maxFreeSockets: 16, keepAliveMsecs: 1000 });
  });

  it("does NOT construct a registered lazy subsystem during bootstrap when lazy is on", async () => {
    const factory = vi.fn(() => ({ heavy: true }));
    const config = NexusConfig.parse({ performance: { lazy: true } });
    const runtime = await buildRuntime(config, { secrets: stubSecrets, subsystems: { rag: factory } });
    expect(factory).not.toHaveBeenCalled();
    expect(runtime.subsystems.isLoaded("rag")).toBe(false);
    // Still lazily constructible on first access.
    expect(runtime.subsystems.get("rag")).toEqual({ heavy: true });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("eagerly constructs registered subsystems at bootstrap when lazy is off", async () => {
    const factory = vi.fn(() => ({ heavy: true }));
    const config = NexusConfig.parse({ performance: { lazy: false } });
    const runtime = await buildRuntime(config, { secrets: stubSecrets, subsystems: { rag: factory } });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(runtime.subsystems.isLoaded("rag")).toBe(true);
  });
});
