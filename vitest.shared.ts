import { defineConfig } from "vitest/config";

/**
 * Shared base config for per-package vitest.config.ts files. Package configs
 * extend this via `mergeConfig` and override only what's package-specific
 * (environment, include globs, esbuild options, env vars, etc.).
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    // Vitest's own default (1.x/2.x) — spelled out here as explicit policy,
    // not a behavior change.
    testTimeout: 5000,
  },
});
