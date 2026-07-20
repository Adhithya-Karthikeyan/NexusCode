/**
 * Workspace-trust gate for local plugin discovery (RCE guard). `loadPlugins`
 * imports (EXECUTES) modules found in the cwd's `node_modules` — a cloned repo
 * shipping `node_modules/nexuscode-plugin-*` must NOT be auto-imported just
 * because a `nexus` command ran in it. Scanning the cwd is allowed only under the
 * explicit `NEXUS_TRUST_WORKSPACE` opt-in (which a repo can never set). Fully
 * offline: the fixture plugin is written into a temp node_modules on disk.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NexusConfig } from "@nexuscode/config";
import { isWorkspaceTrusted, loadPlugins } from "../src/extensions.js";

/** Write a minimal, valid `nexuscode-plugin-*` package into `<dir>/node_modules`. */
function seedWorkspaceWithPlugin(): { cwd: string; emptyDataDir: string } {
  const cwd = mkdtempSync(join(tmpdir(), "nx-trust-cwd-"));
  const pkgDir = join(cwd, "node_modules", "nexuscode-plugin-trusttest");
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "plugin.json"),
    JSON.stringify({
      name: "nexuscode-plugin-trusttest",
      version: "1.0.0",
      engines: { nexuscode: "^1.0.0" },
      entry: "index.mjs",
      contributes: { tools: ["trust_ping"] },
    }),
    "utf8",
  );
  writeFileSync(
    join(pkgDir, "index.mjs"),
    [
      "export function register(ctx) {",
      "  ctx.contributeTool({",
      "    name: 'trust_ping', description: 'x', permission: 'read',",
      "    schema: { type: 'object' }, async run() { return { ok: true, output: 'pong' }; },",
      "  });",
      "}",
    ].join("\n"),
    "utf8",
  );
  // A data dir with no `plugins/` subdir, so ONLY the cwd node_modules can match.
  const emptyDataDir = mkdtempSync(join(tmpdir(), "nx-trust-data-"));
  return { cwd, emptyDataDir };
}

describe("isWorkspaceTrusted", () => {
  it("is false unless NEXUS_TRUST_WORKSPACE is an explicit truthy opt-in", () => {
    expect(isWorkspaceTrusted({})).toBe(false);
    expect(isWorkspaceTrusted({ NEXUS_TRUST_WORKSPACE: "0" })).toBe(false);
    expect(isWorkspaceTrusted({ NEXUS_TRUST_WORKSPACE: "" })).toBe(false);
    expect(isWorkspaceTrusted({ NEXUS_TRUST_WORKSPACE: "1" })).toBe(true);
    expect(isWorkspaceTrusted({ NEXUS_TRUST_WORKSPACE: "true" })).toBe(true);
  });
});

describe("loadPlugins — cwd node_modules is gated by workspace trust", () => {
  const savedCwd = process.cwd();
  afterEach(() => process.chdir(savedCwd));

  it("does NOT import a cwd node_modules plugin when the workspace is untrusted", async () => {
    const { cwd, emptyDataDir } = seedWorkspaceWithPlugin();
    process.chdir(cwd);
    const config = NexusConfig.parse({}); // plugins.enabled + scanNodeModules default true
    const { loaded } = await loadPlugins(config, {
      env: { NEXUS_DATA_DIR: emptyDataDir }, // no trust flag
    });
    expect(loaded.some((p) => p.manifest.name === "nexuscode-plugin-trusttest")).toBe(false);
  });

  it("imports the cwd node_modules plugin only under NEXUS_TRUST_WORKSPACE", async () => {
    const { cwd, emptyDataDir } = seedWorkspaceWithPlugin();
    process.chdir(cwd);
    const config = NexusConfig.parse({});
    const { loaded } = await loadPlugins(config, {
      env: { NEXUS_DATA_DIR: emptyDataDir, NEXUS_TRUST_WORKSPACE: "1" },
    });
    const p = loaded.find((x) => x.manifest.name === "nexuscode-plugin-trusttest");
    expect(p).toBeDefined();
    expect(p?.contributions.tools.map((t) => t.name)).toContain("trust_ping");
  });
});
