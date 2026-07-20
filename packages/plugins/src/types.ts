/**
 * Public shapes for the plugin system: the constrained register API a plugin
 * module is handed, the contribution kinds a plugin can add, and the discovery/
 * load records the host produces.
 */

import type { ProviderAdapter } from "@nexuscode/core";
import type { Tool } from "@nexuscode/tools";
import type { McpServerConfig } from "@nexuscode/config";
import type { PluginManifest } from "./manifest.js";

/**
 * A CLI subcommand contributed by a plugin. `run` is an optional handler; the
 * host records the descriptor into the command list the CLI dispatches over
 * (keeping the plugins package free of a hard CLI dependency).
 */
export interface PluginCommand {
  /** Subcommand name (must match a declared `contributes.commands` entry). */
  name: string;
  /** One-line help text. */
  description: string;
  /** Optional argv handler. */
  run?: (argv: string[]) => void | Promise<void>;
}

/** A prompt template contributed by a plugin, registered into the PromptEngine. */
export interface PluginPrompt {
  /** Template id (must match a declared `contributes.prompts` entry). */
  id: string;
  /** Template version (strict versioning is enforced by the PromptEngine). */
  version: string;
  /** Template body with `{{variable}}` placeholders. */
  body: string;
}

/** A TUI panel descriptor contributed by a plugin. */
export interface PluginUiPanel {
  /** Panel id (must match a declared `contributes.uiPanels` entry). */
  id: string;
  /** Human title shown in the panel chrome. */
  title: string;
  /** Where the host should mount the panel. */
  placement?: "sidebar" | "bottom" | "main";
}

/**
 * The accumulated contributions of a single plugin. Every id here must be
 * declared in the manifest's `contributes` block or the host rejects the plugin.
 */
export interface PluginContributions {
  providers: ProviderAdapter[];
  tools: Tool[];
  commands: PluginCommand[];
  prompts: PluginPrompt[];
  mcpServers: McpServerConfig[];
  uiPanels: PluginUiPanel[];
}

/**
 * The CONSTRAINED context handed to a plugin's `register(host)` function. It is
 * the plugin's only channel to the host: it exposes *add* methods that accumulate
 * contributions (validated later against the manifest) plus read-only metadata.
 * It deliberately does NOT expose the live engine, registries, secrets, or the
 * filesystem — a plugin cannot reach past this surface to mutate host state.
 */
export interface PluginRegisterContext {
  /** The validated manifest of the plugin being registered (read-only). */
  readonly manifest: PluginManifest;
  /** The host version the plugin is loading into (read-only). */
  readonly hostVersion: string;
  /** A scoped logger — messages are prefixed with the plugin name by the host. */
  readonly log: (message: string) => void;
  contributeProvider(adapter: ProviderAdapter): void;
  contributeTool(tool: Tool): void;
  contributeCommand(command: PluginCommand): void;
  contributePrompt(prompt: PluginPrompt): void;
  contributeMcpServer(server: McpServerConfig): void;
  contributeUiPanel(panel: PluginUiPanel): void;
}

/** A plugin's `register` function — the primary module contract. */
export type PluginRegister = (ctx: PluginRegisterContext) => void | Promise<void>;

/**
 * A declarative contributions object — the alternative module contract for
 * plugins with no imperative setup. All fields optional.
 */
export interface PluginContributionsInput {
  providers?: ProviderAdapter[];
  tools?: Tool[];
  commands?: PluginCommand[];
  prompts?: PluginPrompt[];
  mcpServers?: McpServerConfig[];
  uiPanels?: PluginUiPanel[];
}

/**
 * The accepted shapes of a loaded plugin module. A plugin exports EITHER:
 *   - a default `register(ctx)` function, or
 *   - a default (or named `contributes`) declarative contributions object, or
 *   - a named `register` function.
 */
export interface PluginModule {
  default?: PluginRegister | PluginContributionsInput;
  register?: PluginRegister;
  contributes?: PluginContributionsInput;
}

/** Where a discovered plugin came from. */
export type PluginSource = "directory" | "npm";

/** A plugin found by discovery, before its module has been imported. */
export interface DiscoveredPlugin {
  manifest: PluginManifest;
  /** Absolute base directory of the plugin. */
  dir: string;
  /** Absolute path to the entry module to import. */
  entryPath: string;
  source: PluginSource;
}

/** A malformed/undiscoverable candidate, kept so discovery can report it. */
export interface DiscoveryError {
  /** Best-effort identifier (dir name or package name). */
  id: string;
  /** Absolute path of the candidate. */
  path: string;
  source: PluginSource;
  error: string;
}

/** The outcome of scanning the configured discovery sources. */
export interface DiscoveryResult {
  plugins: DiscoveredPlugin[];
  errors: DiscoveryError[];
}

/** A fully loaded, validated, sandboxed plugin ready to be registered. */
export interface LoadedPlugin {
  manifest: PluginManifest;
  dir: string;
  source: PluginSource;
  contributions: PluginContributions;
}

/** Why a plugin failed to load. */
export type LoadFailureReason =
  | "invalid-manifest"
  | "incompatible"
  | "load-error"
  | "capability-violation"
  | "duplicate";

/** A plugin that failed to load — isolated so one bad plugin never crashes the host. */
export interface LoadFailure {
  /** Plugin name (or best-effort id when the manifest itself was invalid). */
  name: string;
  reason: LoadFailureReason;
  /** Human-readable, safe-to-log explanation. */
  error: string;
  source: PluginSource;
}

/** The outcome of loading every discovered plugin. */
export interface LoadResult {
  loaded: LoadedPlugin[];
  failures: LoadFailure[];
}

/**
 * The engine surfaces a set of loaded plugins is applied to. Every target is
 * optional so a caller can apply only the subset it owns (e.g. the REST daemon
 * has no TUI panels). Providers/tools/prompts land in the SAME registries the
 * builtins use, so plugin contributions are governed by the identical
 * permission/gating and routing as first-party ones.
 */
export interface RegisterTargets {
  /** Live provider registry (from the runtime bootstrap). */
  providerRegistry?: {
    has(id: string): boolean;
    register(adapter: ProviderAdapter, opts?: { skipHealth?: boolean }): Promise<void>;
  };
  /** Live tool registry. */
  toolRegistry?: {
    has(name: string): boolean;
    register(tool: Tool): void;
  };
  /** Live prompt engine. */
  promptEngine?: {
    hasTemplate(id: string, version?: string): boolean;
    registerTemplate(id: string, version: string, body: string): void;
  };
  /** Sink array the host appends contributed MCP server configs to. */
  mcpServers?: McpServerConfig[];
  /** Sink array the host appends contributed CLI commands to. */
  commands?: PluginCommand[];
  /** Sink array the host appends contributed TUI panels to. */
  uiPanels?: PluginUiPanel[];
  /**
   * Register provider adapters WITHOUT running their health probe. Plugin
   * providers are third-party; skipping the probe keeps registration offline and
   * crash-free (reachability is surfaced lazily at call time), mirroring how the
   * runtime bootstrap registers the default cloud catalog. Default `true`.
   */
  skipProviderHealth?: boolean;
}

/** One applied contribution, for the audit/report the host returns. */
export interface AppliedContribution {
  plugin: string;
  kind: "provider" | "tool" | "command" | "prompt" | "mcpServer" | "uiPanel";
  id: string;
}

/** A contribution that could not be applied (e.g. an id already taken). */
export interface SkippedContribution extends AppliedContribution {
  reason: string;
}

/** The result of applying loaded plugins to the engine surfaces. */
export interface RegisterResult {
  applied: AppliedContribution[];
  skipped: SkippedContribution[];
}
