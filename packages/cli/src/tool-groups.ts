/**
 * Wave-9 tool-group wiring (system-spec §6). The six new tool groups —
 * web / browser / db / cloud / containers / ai — are OPT-IN per project: a group
 * is registered into the agent tool-loop only when its name appears in
 * `config.tools.enabledGroups`. Every tool keeps the coarse permission class its
 * package assigned (read / write / exec / network), so the `PermissionGate`
 * gates them exactly like the built-ins — a network/write tool still requires
 * approval outside full-access.
 *
 * The real client libraries backing these tools (playwright, pg, mysql2, the
 * cloud SDKs, docker/kubectl, openai/tesseract, …) are OPTIONAL LAZY
 * dependencies, feature-detected here purely for reporting (`tools list`,
 * `doctor`) — never imported at build time, never a hard dependency. A group is
 * always registerable even when its optional integration is absent; the tool
 * itself returns a clean "not installed" `ToolResult` at call time.
 */

import { webTools, type WebToolsOptions } from "@nexuscode/tools-web";
import { createBrowserTools } from "@nexuscode/tools-browser";
import { createDbTools } from "@nexuscode/tools-db";
import { createCloudTools } from "@nexuscode/tools-cloud";
import { createContainerTools } from "@nexuscode/tools-containers";
import { createAiTools } from "@nexuscode/tools-ai";
import { createRequire } from "node:module";
import type { Tool, ToolRegistry } from "@nexuscode/tools";
import type { NexusConfig, ToolGroupName } from "@nexuscode/config";
import { binaryOnPath } from "./runtime.js";

/**
 * Resolve optional packages relative to THIS module (so workspace-hoisted
 * `node_modules` is searched). `require.resolve` only checks that the package is
 * installed — it never executes the module, so a native addon (better-sqlite3)
 * isn't loaded just to report its presence.
 */
const requireFrom = createRequire(import.meta.url);

/** True when an optional npm package is installed (resolvable) in this install. */
function npmAvailable(spec: string): boolean {
  try {
    requireFrom.resolve(spec);
    return true;
  } catch {
    return false;
  }
}

/** A single optional integration a group can (but need not) use at call time. */
export interface OptionalIntegration {
  /** Human name of the package/binary, e.g. "playwright", "pg", "docker". */
  name: string;
  /** How it is detected: an importable npm package or a binary on PATH. */
  kind: "npm" | "bin";
  /** True when detected in this environment. */
  available: boolean;
  /** How to obtain it, e.g. "npm i playwright" or "install the docker CLI". */
  hint: string;
}

interface IntegrationSpec {
  name: string;
  kind: "npm" | "bin";
  hint: string;
}

/** Static, declarative catalog: which optional integrations each group probes. */
const GROUP_INTEGRATIONS: Record<ToolGroupName, IntegrationSpec[]> = {
  web: [], // native fetch — always available; no optional integration required.
  browser: [{ name: "playwright", kind: "npm", hint: "npm i playwright" }],
  db: [
    { name: "better-sqlite3", kind: "npm", hint: "npm i better-sqlite3" },
    { name: "pg", kind: "npm", hint: "npm i pg" },
    { name: "mysql2", kind: "npm", hint: "npm i mysql2" },
    { name: "snowflake-sdk", kind: "npm", hint: "npm i snowflake-sdk" },
    { name: "@google-cloud/bigquery", kind: "npm", hint: "npm i @google-cloud/bigquery" },
  ],
  cloud: [
    { name: "@aws-sdk/client-s3", kind: "npm", hint: "npm i @aws-sdk/client-s3" },
    { name: "@azure/identity", kind: "npm", hint: "npm i @azure/identity @azure/arm-resources" },
    { name: "@google-cloud/storage", kind: "npm", hint: "npm i @google-cloud/storage" },
  ],
  containers: [
    { name: "docker", kind: "bin", hint: "install the docker CLI" },
    { name: "kubectl", kind: "bin", hint: "install kubectl" },
    { name: "oc", kind: "bin", hint: "install the OpenShift oc CLI" },
  ],
  ai: [
    { name: "openai", kind: "npm", hint: "npm i openai" },
    { name: "tesseract.js", kind: "npm", hint: "npm i tesseract.js" },
  ],
};

/** One-line description of each group, for `tools list` / `doctor`. */
const GROUP_DESCRIPTIONS: Record<ToolGroupName, string> = {
  web: "web search / fetch / crawl (native fetch; SSRF-guarded)",
  browser: "headless browser automation (navigate/click/extract/screenshot)",
  db: "parameterized SQL query + schema introspection (sqlite/postgres/mysql/snowflake/bigquery)",
  cloud: "read-oriented cloud resource list/describe (aws/azure/gcp)",
  containers: "read-oriented docker / kubernetes / openshift inspection",
  ai: "vision / OCR / image-generation / speech",
};

/** The canonical group order for stable listing. */
export const TOOL_GROUP_NAMES: readonly ToolGroupName[] = [
  "web",
  "browser",
  "db",
  "cloud",
  "containers",
  "ai",
] as const;

/**
 * Resolve the `web_search` provider selection from config into `webTools`
 * options. When `http` is selected we let the tool group's own environment
 * resolution pick up the real provider (behind an API key); otherwise the
 * deterministic offline mock provider is forced so nothing hits the network.
 */
function webToolsOptions(config: NexusConfig): WebToolsOptions {
  const opts: WebToolsOptions = {};
  const web = config.tools.web;
  if (web.defaultMaxResults !== undefined) opts.defaultMaxResults = web.defaultMaxResults;
  // `http` ⇒ fall through to the group's env-based provider resolution (real HTTP
  // provider when a key is set, else the offline mock). `mock` ⇒ omit the
  // provider too; the group defaults to the offline mock when no key is present.
  return opts;
}

/** Build the tools for one group from config. Never throws; never imports a heavy lib. */
export function buildToolGroup(group: ToolGroupName, config: NexusConfig): Tool[] {
  switch (group) {
    case "web":
      return webTools(webToolsOptions(config));
    case "browser":
      return createBrowserTools();
    case "db":
      return createDbTools();
    case "cloud":
      return createCloudTools();
    case "containers":
      return createContainerTools();
    case "ai":
      return createAiTools();
    default:
      return [];
  }
}

/** The tool names a group exposes (built once, config-independent for names). */
export function toolNamesOfGroup(group: ToolGroupName, config: NexusConfig): string[] {
  return buildToolGroup(group, config).map((t) => t.name);
}

export interface RegisteredGroup {
  group: ToolGroupName;
  /** Tools actually registered (collisions with an existing name are skipped). */
  toolNames: string[];
}

/**
 * Register every enabled tool group into `registry` (additively; a name already
 * present — e.g. a built-in or MCP tool — is never overwritten). Returns what was
 * registered per group so a caller can report it. Fully offline: building a group
 * never loads its optional client library.
 */
export function registerToolGroups(registry: ToolRegistry, config: NexusConfig): RegisteredGroup[] {
  const out: RegisteredGroup[] = [];
  // De-dupe while preserving the canonical order.
  const enabled = TOOL_GROUP_NAMES.filter((g) => config.tools.enabledGroups.includes(g));
  for (const group of enabled) {
    const toolNames: string[] = [];
    for (const tool of buildToolGroup(group, config)) {
      if (registry.has(tool.name)) continue;
      registry.register(tool);
      toolNames.push(tool.name);
    }
    out.push({ group, toolNames });
  }
  return out;
}

/** Reverse map: which group a tool name belongs to (config-independent). */
export function groupOfTool(name: string): ToolGroupName | undefined {
  for (const group of TOOL_GROUP_NAMES) {
    if (STATIC_TOOL_NAMES[group].includes(name)) return group;
  }
  return undefined;
}

/**
 * The static tool-name roster per group. Kept in sync with each group factory;
 * used for the reverse lookup + `tools list` without building every group.
 */
const STATIC_TOOL_NAMES: Record<ToolGroupName, string[]> = {
  web: ["web_search", "web_fetch", "web_crawl"],
  browser: ["browser_navigate", "browser_click", "browser_extract", "browser_screenshot"],
  db: ["db_query", "db_schema"],
  cloud: ["cloud_list", "cloud_describe"],
  containers: ["docker_ps", "docker_images", "docker_logs", "k8s_get", "k8s_logs"],
  ai: ["ai_vision", "ai_ocr", "ai_image_generate", "ai_speech"],
};

export interface ToolGroupReport {
  group: ToolGroupName;
  description: string;
  toolNames: string[];
  enabled: boolean;
  integrations: OptionalIntegration[];
}

/** Feature-detect one group's optional integrations (for `tools list` / `doctor`). */
export async function probeIntegrations(group: ToolGroupName): Promise<OptionalIntegration[]> {
  const specs = GROUP_INTEGRATIONS[group];
  return Promise.all(
    specs.map(async (spec): Promise<OptionalIntegration> => {
      const available = spec.kind === "bin" ? binaryOnPath(spec.name) : npmAvailable(spec.name);
      return { name: spec.name, kind: spec.kind, available, hint: spec.hint };
    }),
  );
}

/**
 * Full report of every tool group: description, tools, whether it's enabled in
 * config, and the availability of each optional integration. Offline: only
 * feature-detection (dynamic import / PATH probe), no tool ever runs.
 */
export async function reportToolGroups(config: NexusConfig): Promise<ToolGroupReport[]> {
  return Promise.all(
    TOOL_GROUP_NAMES.map(async (group): Promise<ToolGroupReport> => ({
      group,
      description: GROUP_DESCRIPTIONS[group],
      toolNames: STATIC_TOOL_NAMES[group],
      enabled: config.tools.enabledGroups.includes(group),
      integrations: await probeIntegrations(group),
    })),
  );
}

export { STATIC_TOOL_NAMES, GROUP_DESCRIPTIONS };
