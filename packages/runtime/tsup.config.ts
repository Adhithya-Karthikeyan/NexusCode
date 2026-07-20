import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  // The provider packages are loaded through dynamic `import()` so a missing or
  // broken provider degrades to an unavailable status instead of taking down the
  // host. They must stay EXTERNAL: tsup bundles optionalDependencies whose import
  // specifier is a string literal (provider-openai/azure), which breaks their
  // runtime resolution + graceful-degradation contract. Keeping every workspace
  // package external mirrors how the CLI built this same bootstrap.
  external: [/^@nexuscode\//],
});
