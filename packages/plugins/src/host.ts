/**
 * PluginHost (system-spec §9) — discovery, versioning, sandboxed loading, and
 * contribution registration for NexusCode plugins.
 *
 * The host is a CLIENT of the engine: it never re-implements provider/tool/
 * prompt/mcp machinery. Discovery finds plugins, loading validates + isolates
 * them, and `register` applies their contributions into the SAME registries the
 * builtins use, so a plugin's provider is routed, and its tool is gated, exactly
 * like a first-party one.
 *
 * Four guarantees:
 *   - Discovery: from a plugins directory (each subdir a plugin) AND from
 *     installed npm packages matching `nexuscode-plugin-*`.
 *   - Versioning: a plugin whose `engines.nexuscode` range excludes the host
 *     version is rejected and never imported.
 *   - Fault isolation (NOT a security sandbox): the manifest is validated before
 *     any code runs; the module is imported and its `register` executed inside
 *     try/catch, so a plugin that THROWS is isolated with a clear error and the
 *     host survives. This bounds crashes, NOT privileges — `await import()` runs
 *     the plugin's top-level module code with full Node privileges (fs, network,
 *     child_process, SecretStore files). The constrained register context limits
 *     which CONTRIBUTIONS a plugin can register; it does not confine the code that
 *     already ran at import time. Discovery/import must therefore be gated by
 *     workspace trust upstream (see the CLI's plugin loader) — only trusted
 *     directories are ever imported.
 *   - Capability limits: every runtime contribution must match an id declared in
 *     the manifest's `contributes` block — a plugin cannot silently exceed it.
 *     Note this runs AFTER import, so it constrains contributions, not execution.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProviderAdapter } from "@nexuscode/core";
import type { Tool } from "@nexuscode/tools";
import type { McpServerConfig } from "@nexuscode/config";
import { satisfies } from "./semver.js";
import {
  manifestFromPackageJson,
  parsePluginManifest,
  PLUGIN_PACKAGE_PREFIX,
  type PluginManifest,
} from "./manifest.js";
import type {
  AppliedContribution,
  DiscoveredPlugin,
  DiscoveryError,
  DiscoveryResult,
  LoadedPlugin,
  LoadFailure,
  LoadResult,
  PluginCommand,
  PluginContributions,
  PluginContributionsInput,
  PluginModule,
  PluginPrompt,
  PluginRegister,
  PluginRegisterContext,
  PluginSource,
  PluginUiPanel,
  RegisterResult,
  RegisterTargets,
  SkippedContribution,
} from "./types.js";

/**
 * The NexusCode product version plugins are checked against by default. Callers
 * (the CLI/runtime/daemon) SHOULD pass their real version via
 * {@link PluginHostOptions.hostVersion}; this is only the fallback.
 */
export const DEFAULT_HOST_VERSION = "1.0.0";

/** Candidate entry filenames probed when a manifest declares no explicit entry. */
const ENTRY_CANDIDATES = ["index.js", "index.mjs", "index.cjs"];

/** Manifest filenames probed inside a plugin directory, in priority order. */
const MANIFEST_FILES = ["plugin.json", "nexuscode.plugin.json"];

export interface PluginHostOptions {
  /**
   * Directories whose immediate subdirectories are each a plugin (a manifest +
   * entry module). This is the user's plugins dir under the config/data dir.
   */
  pluginDirs?: string[];
  /**
   * `node_modules` directories scanned for installed plugin packages whose name
   * starts with `nexuscode-plugin-`. Both the plain and `@nexuscode/plugin-*`
   * scoped forms are recognized.
   */
  nodeModulesDirs?: string[];
  /** Host version plugins' `engines.nexuscode` range is checked against. */
  hostVersion?: string;
  /** Optional log sink for plugin diagnostics (default: no-op). */
  logger?: (message: string) => void;
}

/** Build an empty contributions accumulator. */
function emptyContributions(): PluginContributions {
  return { providers: [], tools: [], commands: [], prompts: [], mcpServers: [], uiPanels: [] };
}

/** Read + JSON-parse a file, returning `undefined` on any error. */
function readJson(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Is `p` an existing directory? */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export class PluginHost {
  private readonly pluginDirs: string[];
  private readonly nodeModulesDirs: string[];
  private readonly hostVersion: string;
  private readonly logger: (message: string) => void;

  constructor(opts: PluginHostOptions = {}) {
    this.pluginDirs = opts.pluginDirs ? [...opts.pluginDirs] : [];
    this.nodeModulesDirs = opts.nodeModulesDirs ? [...opts.nodeModulesDirs] : [];
    this.hostVersion = opts.hostVersion ?? DEFAULT_HOST_VERSION;
    this.logger = opts.logger ?? (() => {});
  }

  /** The host version plugins are compat-checked against. */
  getHostVersion(): string {
    return this.hostVersion;
  }

  // ── Discovery ────────────────────────────────────────────────────────────

  /**
   * Scan every configured source for plugins. Returns the well-formed
   * candidates plus per-candidate errors (a malformed manifest or missing entry
   * is reported, never thrown). No plugin code is imported here.
   */
  discover(): DiscoveryResult {
    const plugins: DiscoveredPlugin[] = [];
    const errors: DiscoveryError[] = [];
    const seen = new Set<string>();

    for (const root of this.pluginDirs) {
      if (!isDir(root)) continue;
      for (const name of this.safeReaddir(root)) {
        const dir = join(root, name);
        if (!isDir(dir)) continue;
        this.discoverOne(dir, "directory", plugins, errors, seen);
      }
    }

    for (const nm of this.nodeModulesDirs) {
      if (!isDir(nm)) continue;
      for (const dir of this.pluginPackageDirs(nm)) {
        this.discoverOne(dir, "npm", plugins, errors, seen);
      }
    }

    return { plugins, errors };
  }

  /** `readdirSync` that never throws. */
  private safeReaddir(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }

  /**
   * Resolve the plugin-package directories inside a `node_modules`: top-level
   * `nexuscode-plugin-*` packages plus `@nexuscode/plugin-*` scoped packages.
   */
  private pluginPackageDirs(nodeModules: string): string[] {
    const out: string[] = [];
    for (const name of this.safeReaddir(nodeModules)) {
      if (name.startsWith(PLUGIN_PACKAGE_PREFIX)) {
        out.push(join(nodeModules, name));
      } else if (name === "@nexuscode") {
        const scope = join(nodeModules, name);
        for (const sub of this.safeReaddir(scope)) {
          if (sub.startsWith("plugin-")) out.push(join(scope, sub));
        }
      }
    }
    return out;
  }

  /** Discover a single plugin directory, appending to `plugins` or `errors`. */
  private discoverOne(
    dir: string,
    source: PluginSource,
    plugins: DiscoveredPlugin[],
    errors: DiscoveryError[],
    seen: Set<string>,
  ): void {
    const raw = this.readManifestSource(dir);
    if (!raw) {
      errors.push({ id: basenameOf(dir), path: dir, source, error: "no manifest (plugin.json or package.json) found" });
      return;
    }
    const parsed = parsePluginManifest(raw.manifest);
    if (!parsed.ok) {
      errors.push({ id: basenameOf(dir), path: dir, source, error: `invalid manifest: ${parsed.error}` });
      return;
    }
    const manifest = parsed.manifest;
    if (seen.has(manifest.name)) {
      errors.push({ id: manifest.name, path: dir, source, error: `duplicate plugin name "${manifest.name}" (already discovered)` });
      return;
    }
    const entryPath = this.resolveEntry(dir, manifest);
    if (!entryPath) {
      errors.push({ id: manifest.name, path: dir, source, error: "entry module not found" });
      return;
    }
    seen.add(manifest.name);
    plugins.push({ manifest, dir, entryPath, source });
  }

  /**
   * Read the manifest for a plugin directory: prefer a dedicated `plugin.json`,
   * else derive one from `package.json`. Returns the raw (unvalidated) object.
   */
  private readManifestSource(dir: string): { manifest: unknown } | undefined {
    for (const file of MANIFEST_FILES) {
      const path = join(dir, file);
      if (existsSync(path)) {
        const json = readJson(path);
        if (json) return { manifest: json };
      }
    }
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (pkg) return { manifest: manifestFromPackageJson(pkg) };
    }
    return undefined;
  }

  /** Resolve the absolute entry-module path, or `undefined` if none exists. */
  private resolveEntry(dir: string, manifest: PluginManifest): string | undefined {
    if (manifest.entry) {
      const p = isAbsolute(manifest.entry) ? manifest.entry : resolve(dir, manifest.entry);
      return existsSync(p) ? p : undefined;
    }
    for (const cand of ENTRY_CANDIDATES) {
      const p = join(dir, cand);
      if (existsSync(p)) return p;
    }
    return undefined;
  }

  // ── Loading (sandboxed) ────────────────────────────────────────────────────

  /**
   * Load one discovered plugin: enforce the version gate, import the module in
   * isolation, run its `register` on a constrained context, then enforce the
   * capability limit. Never throws — every failure mode maps to a `LoadFailure`.
   */
  async load(discovered: DiscoveredPlugin): Promise<{ loaded?: LoadedPlugin; failure?: LoadFailure }> {
    const { manifest, dir, entryPath, source } = discovered;

    // Versioning: reject an incompatible plugin BEFORE importing its code.
    const range = manifest.engines.nexuscode;
    if (range && !satisfies(this.hostVersion, range)) {
      return {
        failure: {
          name: manifest.name,
          reason: "incompatible",
          source,
          error: `requires nexuscode ${range} but host is ${this.hostVersion}`,
        },
      };
    }

    // Fault isolation (NOT a security boundary): import the module inside
    // try/catch so a module that throws at evaluation time is isolated — the host
    // survives with a clear error. The import itself EXECUTES the plugin's
    // top-level code with full Node privileges; callers must only ever pass
    // discovered plugins from trusted directories (workspace-trust gated upstream).
    let mod: PluginModule;
    try {
      mod = (await import(pathToFileURL(entryPath).href)) as PluginModule;
    } catch (e) {
      return {
        failure: { name: manifest.name, reason: "load-error", source, error: `failed to import entry module: ${errMsg(e)}` },
      };
    }

    const register = resolveRegister(mod);
    if (!register) {
      return {
        failure: {
          name: manifest.name,
          reason: "load-error",
          source,
          error: "module exports neither a register() function nor a contributes object",
        },
      };
    }

    // Run register on a CONSTRAINED context, isolated in try/catch.
    const contributions = emptyContributions();
    const ctx = this.makeRegisterContext(manifest, contributions);
    try {
      await register(ctx);
    } catch (e) {
      return {
        failure: { name: manifest.name, reason: "load-error", source, error: `register() threw: ${errMsg(e)}` },
      };
    }

    // Capability limit: every contributed id must be declared in the manifest.
    const violation = checkCapabilities(manifest, contributions);
    if (violation) {
      return {
        failure: { name: manifest.name, reason: "capability-violation", source, error: violation },
      };
    }

    void dir; // retained on the loaded record below
    return { loaded: { manifest, dir, source, contributions } };
  }

  /**
   * Discover then load every plugin, isolating failures. Discovery errors
   * (bad manifest / missing entry) surface as `invalid-manifest` failures so a
   * single result carries the complete picture.
   */
  async loadAll(): Promise<LoadResult> {
    const { plugins, errors } = this.discover();
    const loaded: LoadedPlugin[] = [];
    const failures: LoadFailure[] = [];

    for (const de of errors) {
      failures.push({ name: de.id, reason: "invalid-manifest", source: de.source, error: de.error });
    }

    for (const d of plugins) {
      const { loaded: ok, failure } = await this.load(d);
      if (ok) loaded.push(ok);
      else if (failure) failures.push(failure);
    }

    return { loaded, failures };
  }

  /** Build the constrained register context handed to a plugin module. */
  private makeRegisterContext(
    manifest: PluginManifest,
    into: PluginContributions,
  ): PluginRegisterContext {
    const hostVersion = this.hostVersion;
    const logger = this.logger;
    return {
      manifest,
      hostVersion,
      log: (message: string) => logger(`[plugin:${manifest.name}] ${message}`),
      contributeProvider(adapter: ProviderAdapter): void {
        into.providers.push(adapter);
      },
      contributeTool(tool: Tool): void {
        into.tools.push(tool);
      },
      contributeCommand(command: PluginCommand): void {
        into.commands.push(command);
      },
      contributePrompt(prompt: PluginPrompt): void {
        into.prompts.push(prompt);
      },
      contributeMcpServer(server: McpServerConfig): void {
        into.mcpServers.push(server);
      },
      contributeUiPanel(panel: PluginUiPanel): void {
        into.uiPanels.push(panel);
      },
    };
  }

  // ── Registration (apply to the engine surfaces) ────────────────────────────

  /**
   * Apply loaded plugins' contributions into the engine surfaces in `targets`.
   * Contributions land in the SAME registries the builtins use, so they inherit
   * the identical routing/permission-gating. Each application is isolated: a
   * duplicate id or a failing single registration is recorded as `skipped` and
   * never aborts the rest. Returns an audit of what was applied vs skipped.
   */
  async register(loaded: readonly LoadedPlugin[], targets: RegisterTargets): Promise<RegisterResult> {
    const applied: AppliedContribution[] = [];
    const skipped: SkippedContribution[] = [];
    const skipHealth = targets.skipProviderHealth ?? true;

    for (const plugin of loaded) {
      const pn = plugin.manifest.name;
      const c = plugin.contributions;

      // Providers → the live ProviderRegistry (router-visible, offline register).
      if (targets.providerRegistry) {
        for (const adapter of c.providers) {
          const rec: AppliedContribution = { plugin: pn, kind: "provider", id: adapter.id };
          if (targets.providerRegistry.has(adapter.id)) {
            skipped.push({ ...rec, reason: "provider id already registered" });
            continue;
          }
          try {
            await targets.providerRegistry.register(adapter, { skipHealth });
            applied.push(rec);
          } catch (e) {
            skipped.push({ ...rec, reason: errMsg(e) });
          }
        }
      }

      // Tools → the live ToolRegistry (gated by the PermissionGate at exec time).
      if (targets.toolRegistry) {
        for (const tool of c.tools) {
          const rec: AppliedContribution = { plugin: pn, kind: "tool", id: tool.name };
          if (targets.toolRegistry.has(tool.name)) {
            skipped.push({ ...rec, reason: "tool name already registered" });
            continue;
          }
          try {
            targets.toolRegistry.register(tool);
            applied.push(rec);
          } catch (e) {
            skipped.push({ ...rec, reason: errMsg(e) });
          }
        }
      }

      // Prompts → the PromptEngine (versioned templates).
      if (targets.promptEngine) {
        for (const prompt of c.prompts) {
          const rec: AppliedContribution = { plugin: pn, kind: "prompt", id: `${prompt.id}@${prompt.version}` };
          if (targets.promptEngine.hasTemplate(prompt.id, prompt.version)) {
            skipped.push({ ...rec, reason: "template version already registered" });
            continue;
          }
          try {
            targets.promptEngine.registerTemplate(prompt.id, prompt.version, prompt.body);
            applied.push(rec);
          } catch (e) {
            skipped.push({ ...rec, reason: errMsg(e) });
          }
        }
      }

      // MCP servers → the sink the caller passes to McpClientManager.add().
      if (targets.mcpServers) {
        for (const server of c.mcpServers) {
          const rec: AppliedContribution = { plugin: pn, kind: "mcpServer", id: server.name };
          if (targets.mcpServers.some((s) => s.name === server.name)) {
            skipped.push({ ...rec, reason: "mcp server name already present" });
            continue;
          }
          targets.mcpServers.push(server);
          applied.push(rec);
        }
      }

      // CLI commands → the sink the caller dispatches over.
      if (targets.commands) {
        for (const command of c.commands) {
          const rec: AppliedContribution = { plugin: pn, kind: "command", id: command.name };
          if (targets.commands.some((cmd) => cmd.name === command.name)) {
            skipped.push({ ...rec, reason: "command name already present" });
            continue;
          }
          targets.commands.push(command);
          applied.push(rec);
        }
      }

      // TUI panels → the sink the caller mounts.
      if (targets.uiPanels) {
        for (const panel of c.uiPanels) {
          const rec: AppliedContribution = { plugin: pn, kind: "uiPanel", id: panel.id };
          if (targets.uiPanels.some((p) => p.id === panel.id)) {
            skipped.push({ ...rec, reason: "panel id already present" });
            continue;
          }
          targets.uiPanels.push(panel);
          applied.push(rec);
        }
      }
    }

    return { applied, skipped };
  }
}

/** Normalize a loaded module into a single register function, or `undefined`. */
function resolveRegister(mod: PluginModule): PluginRegister | undefined {
  if (typeof mod.register === "function") return mod.register;
  if (typeof mod.default === "function") return mod.default as PluginRegister;
  if (mod.contributes && typeof mod.contributes === "object") {
    return contributionsToRegister(mod.contributes);
  }
  if (mod.default && typeof mod.default === "object") {
    const maybe = mod.default as PluginContributionsInput & { contributes?: PluginContributionsInput };
    const contributes = maybe.contributes ?? maybe;
    return contributionsToRegister(contributes);
  }
  return undefined;
}

/** Adapt a declarative contributions object into a register function. */
function contributionsToRegister(input: PluginContributionsInput): PluginRegister {
  return (ctx: PluginRegisterContext) => {
    for (const p of input.providers ?? []) ctx.contributeProvider(p);
    for (const t of input.tools ?? []) ctx.contributeTool(t);
    for (const cmd of input.commands ?? []) ctx.contributeCommand(cmd);
    for (const pr of input.prompts ?? []) ctx.contributePrompt(pr);
    for (const m of input.mcpServers ?? []) ctx.contributeMcpServer(m);
    for (const panel of input.uiPanels ?? []) ctx.contributeUiPanel(panel);
  };
}

/**
 * Enforce the capability limit: every contributed id must be declared in the
 * manifest's `contributes` block. Returns a human-readable violation message, or
 * `undefined` when the plugin stays within its declared surface.
 */
function checkCapabilities(manifest: PluginManifest, c: PluginContributions): string | undefined {
  const decl = manifest.contributes;
  const violations: string[] = [];
  const check = (kind: string, ids: string[], declared: string[]): void => {
    const allow = new Set(declared);
    for (const id of ids) {
      if (!allow.has(id)) violations.push(`${kind} "${id}"`);
    }
  };
  check("provider", c.providers.map((p) => p.id), decl.providers);
  check("tool", c.tools.map((t) => t.name), decl.tools);
  check("command", c.commands.map((cmd) => cmd.name), decl.commands);
  check("prompt", c.prompts.map((p) => p.id), decl.prompts);
  check("mcpServer", c.mcpServers.map((s) => s.name), decl.mcpServers);
  check("uiPanel", c.uiPanels.map((p) => p.id), decl.uiPanels);
  if (violations.length === 0) return undefined;
  return `undeclared contributions (not in manifest.contributes): ${violations.join(", ")}`;
}

/** Best-effort error message extraction. */
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Last path segment of an absolute directory. */
function basenameOf(dir: string): string {
  const parts = dir.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? dir;
}
