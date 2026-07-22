import { defineWorkspace } from "vitest/config";

/**
 * One vitest project per publishable package. We enumerate the leaf packages
 * explicitly (rather than `packages/*`) so the `packages/providers` *aggregator*
 * directory is not itself picked up as a project — that would double-run every
 * provider suite under both a "providers" project and its real package project.
 */
export default defineWorkspace([
  "packages/shared",
  "packages/config",
  "packages/transfer",
  "packages/auth",
  "packages/core",
  "packages/runtime",
  "packages/sdk",
  "packages/server",
  "packages/session",
  "packages/cli",
  "packages/tools",
  "packages/tools-web",
  "packages/tools-db",
  "packages/tools-browser",
  "packages/tools-containers",
  "packages/mcp",
  "packages/plugins",
  "packages/prompt",
  "packages/context",
  "packages/tasks",
  "packages/agent",
  "packages/rag",
  "packages/cache",
  "packages/observability",
  "packages/hooks",
  "packages/fileintel",
  "packages/lsp",
  "packages/git",
  "packages/tools-cloud",
  "packages/tools-ai",
  "packages/theme",
  "packages/tui",
  "packages/enterprise",
  "packages/providers/*",
]);
