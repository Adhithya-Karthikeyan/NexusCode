/**
 * Performance settings (system-spec §23, Wave 12): the `performance` section must
 * default so an existing config keeps parsing (every default reproducing the
 * pre-Wave-12 behavior), and each knob must be overridable through the cascade.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, NexusConfig } from "@nexuscode/config";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "nx-perf-"));
}

describe("performance config", () => {
  it("applies Wave-12 defaults when nothing is configured", async () => {
    const { config } = await loadConfig({ cwd: tmp(), userConfigDir: tmp(), env: {}, flags: {} });
    expect(config.performance.pool.maxSockets).toBe(64);
    expect(config.performance.pool.maxFreeSockets).toBe(16);
    expect(config.performance.pool.keepAliveMsecs).toBe(1000);
    // Lazy init is on by default (fast startup); background off; watch debounce 150ms.
    expect(config.performance.lazy).toBe(true);
    expect(config.performance.background).toBe(false);
    expect(config.performance.watch.debounceMs).toBe(150);
    expect(config.performance.watch.prune).toBe(false);
  });

  it("a config with no performance section still parses (backward compatible)", () => {
    const parsed = NexusConfig.parse({ defaultProvider: "mock" });
    expect(parsed.performance.pool.maxSockets).toBe(64);
    expect(parsed.performance.lazy).toBe(true);
  });

  it("overrides each performance knob through the user layer", async () => {
    const userDir = tmp();
    writeFileSync(
      join(userDir, "config.json"),
      JSON.stringify({
        performance: {
          pool: { maxSockets: 8, maxFreeSockets: 2, keepAliveMsecs: 500 },
          lazy: false,
          background: true,
          watch: { debounceMs: 42, prune: true },
        },
      }),
      "utf8",
    );
    const { config } = await loadConfig({ cwd: tmp(), userConfigDir: userDir, env: {}, flags: {} });
    expect(config.performance.pool.maxSockets).toBe(8);
    expect(config.performance.pool.maxFreeSockets).toBe(2);
    expect(config.performance.pool.keepAliveMsecs).toBe(500);
    expect(config.performance.lazy).toBe(false);
    expect(config.performance.background).toBe(true);
    expect(config.performance.watch.debounceMs).toBe(42);
    expect(config.performance.watch.prune).toBe(true);
  });

  it("rejects a non-positive pool size (strict schema)", () => {
    expect(() => NexusConfig.parse({ performance: { pool: { maxSockets: 0 } } })).toThrow();
  });
});
