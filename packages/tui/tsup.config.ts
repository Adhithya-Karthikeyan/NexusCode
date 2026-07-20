import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  dts: true,
  clean: true,
  sourcemap: true,
  // JSX via esbuild's automatic runtime (react/jsx-runtime), matching the
  // tsconfig `react-jsx` + `jsxImportSource: react` so .tsx compiles identically
  // for both the bundle (esbuild) and the .d.ts pass (tsc).
  esbuildOptions(options) {
    options.jsx = "automatic";
    options.jsxImportSource = "react";
  },
});
