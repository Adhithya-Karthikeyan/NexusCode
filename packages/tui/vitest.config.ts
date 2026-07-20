import { defineConfig } from "vitest/config";

/**
 * TUI test config — .tsx components compile with the automatic JSX runtime
 * (matching tsup/tsc), so ink-testing-library renders work without a manual
 * React import in every test.
 */
export default defineConfig({
  esbuild: { jsx: "automatic", jsxImportSource: "react" },
  test: {
    environment: "node",
    include: ["test/**/*.test.{ts,tsx}"],
    // Force truecolor so Ink/chalk emits color escapes into the captured frame,
    // letting component tests assert that theme tokens actually reach the output.
    env: { FORCE_COLOR: "3" },
  },
});
