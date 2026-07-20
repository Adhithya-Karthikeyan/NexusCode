import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  // Optional lazy drivers must never be bundled or eagerly resolved — they are
  // loaded through a runtime `import(variable)` and feature-detected at call time.
  external: ["pg", "mysql2", "mysql2/promise", "snowflake-sdk", "@google-cloud/bigquery"],
});
