/**
 * The plugin manifest (system-spec §9) — a marketplace-ready descriptor every
 * plugin ships. It is validated with zod BEFORE the plugin's code is ever
 * imported, so a malformed manifest is rejected at discovery time rather than
 * blowing up mid-load. The manifest is also the plugin's *capability
 * declaration*: `contributes` lists exactly which providers/tools/commands/
 * prompts/mcp-servers/ui-panels the plugin is allowed to add, and the host
 * rejects any contribution whose id was not declared here — a plugin can never
 * silently exceed its declared surface.
 */

import { z } from "zod";
import { isValidSemVer } from "./semver.js";

/** Naming convention for npm-published plugins discovered from node_modules. */
export const PLUGIN_PACKAGE_PREFIX = "nexuscode-plugin-";

/** A version string that must parse as strict semver. */
const SemVerString = z.string().refine((v) => isValidSemVer(v), {
  message: "must be a valid semver version (major.minor.patch)",
});

/**
 * The declared contribution surface. Each field is a list of *ids/names* the
 * plugin promises to contribute. The runtime contributions (real adapters,
 * tools, …) supplied by the plugin module must each match a declared id — this
 * is the capability limit the host enforces.
 */
export const PluginContributionDeclaration = z
  .object({
    /** Provider adapter ids (e.g. "acme-llm"). */
    providers: z.array(z.string().min(1)).default([]),
    /** Tool names (e.g. "acme_search"). */
    tools: z.array(z.string().min(1)).default([]),
    /** CLI subcommand names (e.g. "acme"). */
    commands: z.array(z.string().min(1)).default([]),
    /** Prompt template ids (e.g. "acme.review"). */
    prompts: z.array(z.string().min(1)).default([]),
    /** MCP server names (e.g. "acme-mcp"). */
    mcpServers: z.array(z.string().min(1)).default([]),
    /** TUI panel ids (e.g. "acme.panel"). */
    uiPanels: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type PluginContributionDeclaration = z.infer<typeof PluginContributionDeclaration>;

/**
 * Host/runtime compatibility ranges. `nexuscode` is checked against the host's
 * own version at load time; a plugin outside the range is rejected (never
 * imported). `node` is advisory metadata for the marketplace.
 */
export const PluginEngines = z
  .object({
    /** Semver range of NexusCode host versions this plugin supports. */
    nexuscode: z.string().min(1).optional(),
    /** Semver range of Node.js this plugin supports (advisory). */
    node: z.string().min(1).optional(),
  })
  .strict();
export type PluginEngines = z.infer<typeof PluginEngines>;

export const PluginManifest = z
  .object({
    /** Unique plugin id / package name (e.g. "nexuscode-plugin-acme"). */
    name: z.string().min(1),
    /** Plugin version (strict semver). */
    version: SemVerString,
    /** One-line human description for the marketplace. */
    description: z.string().optional(),
    author: z.string().optional(),
    license: z.string().optional(),
    homepage: z.string().optional(),
    keywords: z.array(z.string()).default([]),
    /** Host/runtime compatibility ranges. */
    engines: PluginEngines.default({}),
    /**
     * Entry module path, relative to the plugin's base directory. Defaults to
     * the package `main` (for npm plugins) or "index.js" (for directory plugins),
     * resolved by the loader — so it is optional here.
     */
    entry: z.string().optional(),
    /** The declared capability surface (see {@link PluginContributionDeclaration}). */
    contributes: PluginContributionDeclaration.default({}),
  })
  .strict();
export type PluginManifestInput = z.input<typeof PluginManifest>;
export type PluginManifest = z.infer<typeof PluginManifest>;

/** Result of a manifest validation attempt. */
export type ManifestParseResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; error: string };

/**
 * Validate an unknown value into a {@link PluginManifest}. Never throws — a bad
 * manifest returns `{ ok: false, error }` with a flattened, human-readable
 * message so discovery can skip the plugin and report why.
 */
export function parsePluginManifest(input: unknown): ManifestParseResult {
  const parsed = PluginManifest.safeParse(input);
  if (parsed.success) return { ok: true, manifest: parsed.data };
  const error = parsed.error.issues
    .map((i) => `${i.path.length ? i.path.join(".") + ": " : ""}${i.message}`)
    .join("; ");
  return { ok: false, error };
}

/**
 * Extract a manifest candidate from a package.json. A published plugin's
 * package.json IS its manifest: standard fields (name/version/…) plus an
 * optional `nexuscode` block carrying `engines`/`entry`/`contributes` overrides.
 * The npm `main` is used as the default entry when the block omits one.
 */
export function manifestFromPackageJson(pkg: Record<string, unknown>): unknown {
  const block = (pkg.nexuscode ?? {}) as Record<string, unknown>;
  const candidate: Record<string, unknown> = {
    name: pkg.name,
    version: pkg.version,
  };
  if (typeof pkg.description === "string") candidate.description = pkg.description;
  if (typeof pkg.author === "string") candidate.author = pkg.author;
  if (typeof pkg.license === "string") candidate.license = pkg.license;
  if (typeof pkg.homepage === "string") candidate.homepage = pkg.homepage;
  if (Array.isArray(pkg.keywords)) candidate.keywords = pkg.keywords;
  // Prefer an explicit nexuscode.engines; else fall back to package.json engines.
  if (block.engines !== undefined) candidate.engines = block.engines;
  else if (pkg.engines !== undefined) candidate.engines = pkg.engines;
  const entry = block.entry ?? pkg.main;
  if (typeof entry === "string") candidate.entry = entry;
  if (block.contributes !== undefined) candidate.contributes = block.contributes;
  return candidate;
}
