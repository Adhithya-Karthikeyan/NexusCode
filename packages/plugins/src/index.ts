/**
 * @nexuscode/plugins — the plugin system (system-spec §9) for NexusCode (Wave 10).
 *
 * A plugin contributes providers (model backends), tools, CLI commands, prompt
 * templates, MCP servers, and TUI panels. This package provides the manifest
 * contract, a `PluginHost` (discovery + versioning + sandboxed loading), and the
 * registration path that applies contributions into the SAME engine registries
 * the builtins use — so a plugin's provider is routed, and its tool is
 * permission-gated, exactly like a first-party one. The host is a client of the
 * engine; it re-implements none of it.
 */

export { PluginHost, DEFAULT_HOST_VERSION } from "./host.js";
export type { PluginHostOptions } from "./host.js";

export {
  PluginManifest,
  PluginEngines,
  PluginContributionDeclaration,
  parsePluginManifest,
  manifestFromPackageJson,
  PLUGIN_PACKAGE_PREFIX,
} from "./manifest.js";
export type { PluginManifestInput, ManifestParseResult } from "./manifest.js";

export { satisfies, parseSemVer, compareSemVer, isValidSemVer } from "./semver.js";
export type { SemVer } from "./semver.js";

export type {
  PluginCommand,
  PluginPrompt,
  PluginUiPanel,
  PluginContributions,
  PluginContributionsInput,
  PluginRegister,
  PluginRegisterContext,
  PluginModule,
  PluginSource,
  DiscoveredPlugin,
  DiscoveryError,
  DiscoveryResult,
  LoadedPlugin,
  LoadFailure,
  LoadFailureReason,
  LoadResult,
  RegisterTargets,
  RegisterResult,
  AppliedContribution,
  SkippedContribution,
} from "./types.js";
