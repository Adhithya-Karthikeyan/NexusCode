import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  // Native N-API addon: never bundle — resolved at runtime as an optional dep.
  external: ["better-sqlite3"],
});
